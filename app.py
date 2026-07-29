"""
app.py - FastAPI Backend cho Debt Tracker (Hỗ trợ Supabase Auth)
"""

import os
import time
from datetime import date
from dotenv import load_dotenv
import logging
import re
from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from supabase import Client, create_client, ClientOptions
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Thiếu SUPABASE_URL hoặc SUPABASE_KEY trong .env")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI(title="Debt Tracker API", version="4.0.0")

# Allow all origins to support Vercel and other deployment hosts.
# Security is handled by Supabase JWT token validation on every API call.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)



class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Middleware chống spam/DDoS cơ bản bằng cách giới hạn số lượng request
    từ một IP trong vòng 1 phút (Sliding Window).
    Có tự dọn dẹp bộ nhớ để tránh memory leak.
    """
    def __init__(self, app, requests_per_minute: int = 120, max_tracked_ips: int = 10000):
        super().__init__(app)
        self.requests_per_minute = requests_per_minute
        self.max_tracked_ips = max_tracked_ips
        self.ip_records = {}
        self._last_cleanup = time.time()

    async def dispatch(self, request: Request, call_next):
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()

        # Dọn dẹp định kỳ mỗi 5 phút để tránh memory leak
        if now - self._last_cleanup > 300:
            self._last_cleanup = now
            self.ip_records = {
                ip: times for ip, times in self.ip_records.items()
                if times and now - times[-1] < 60
            }

        # Nếu đã theo dõi quá nhiều IP, cho qua để tránh từ chối dịch vụ nhầm
        if client_ip not in self.ip_records:
            if len(self.ip_records) < self.max_tracked_ips:
                self.ip_records[client_ip] = []
            else:
                return await call_next(request)

        # Xoá các request cũ hơn 60 giây
        self.ip_records[client_ip] = [
            t for t in self.ip_records[client_ip] if now - t < 60
        ]

        # Kiểm tra vượt quá giới hạn
        if len(self.ip_records[client_ip]) >= self.requests_per_minute:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too Many Requests. Hệ thống đang bảo vệ chống DDoS."}
            )

        self.ip_records[client_ip].append(now)
        return await call_next(request)

app.add_middleware(RateLimitMiddleware, requests_per_minute=120)


def get_auth_client(authorization: str | None = Header(None)) -> Client:
    """
    Xác thực Bearer JWT token từ header Authorization sử dụng Supabase Auth.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Chưa đăng nhập hoặc thiếu Auth Token")
    
    token = authorization.split(" ")[1]
    try:
        user_res = supabase.auth.get_user(token)
        if not user_res or not user_res.user:
            raise HTTPException(status_code=401, detail="Token không hợp lệ hoặc đã hết hạn")
        options = ClientOptions(headers={"Authorization": f"Bearer {token}"})
        req_client = create_client(SUPABASE_URL, SUPABASE_KEY, options=options)
        req_client.user_id = str(user_res.user.id)
        req_client.user_email = user_res.user.email
        return req_client
    except Exception as exc:
        logger.error(f"Auth error: {exc}")
        raise HTTPException(status_code=401, detail="Xác thực thất bại")


def validate_date_format(cls, v):
    if v is None:
        return v
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        return v
    raise ValueError("Invalid date format. Expected YYYY-MM-DD")


def ensure_event_owned_by_user(req_client: Client, event_id: str, user_id: str) -> None:
    event_check = req_client.table("events").select("id").eq("id", event_id).eq("user_id", user_id).execute()
    if not event_check.data:
        raise HTTPException(status_code=403, detail="Event not found or unauthorized")


def ensure_item_owned_by_user(req_client: Client, item_id: str, user_id: str) -> str:
    item_check = req_client.table("event_items").select("event_id").eq("id", item_id).execute()
    if not item_check.data:
        raise HTTPException(status_code=404, detail="Item not found")

    event_id = item_check.data[0].get("event_id")
    if not event_id:
        raise HTTPException(status_code=404, detail="Item not found")

    ensure_event_owned_by_user(req_client, event_id, user_id)
    return event_id


class EventCreate(BaseModel):
    title: str
    event_date: str
    payment_method: str = "-"
    person: str
    debt_type: str = "borrow"
    pay_status: str = "unpaid"
    actual_pay_date: str | None = None

    _validate_date = field_validator("event_date", "actual_pay_date")(validate_date_format)


class ItemCreate(BaseModel):
    event_id: str
    description: str
    amount: float = Field(description="Amount of the item, can be negative for offset")


class EventUpdate(BaseModel):
    title: str | None = None
    event_date: str | None = None
    payment_method: str | None = None
    debt_type: str | None = None
    pay_status: str | None = None
    actual_pay_date: str | None = None

    _validate_date = field_validator("event_date", "actual_pay_date")(validate_date_format)


class ItemUpdate(BaseModel):
    description: str | None = None
    amount: float | None = Field(default=None, description="Amount of the item, can be negative for offset")


class PersonCreate(BaseModel):
    name: str


class AdminAdd(BaseModel):
    email: str


def get_admin_user(req_client: Client = Depends(get_auth_client)):
    user_email = getattr(req_client, "user_email", None)
    if not user_email:
         raise HTTPException(status_code=403, detail="Forbidden")
    
    try:
         resp = req_client.table("admin_users").select("*").eq("email", user_email).execute()
         if not resp.data:
             raise HTTPException(status_code=403, detail="Bạn không có quyền Admin")
    except Exception:
         raise HTTPException(status_code=403, detail="Kiểm tra quyền Admin thất bại")
    
    return req_client


@app.get("/")
def root():
    return FileResponse(os.path.join(os.path.dirname(__file__), "index.html"))


@app.get("/logo1.png")
def get_logo():
    return FileResponse(os.path.join(os.path.dirname(__file__), "logo1.png"))


@app.get("/api/config")
def get_config():
    return {
        "supabaseUrl": SUPABASE_URL,
        "supabaseKey": SUPABASE_KEY
    }




visit_ips: dict[str, float] = {}

@app.post("/api/visits")
def record_visit(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()

    # Dọn dẹp các IP cũ hơn 60 giây để tránh memory leak
    global visit_ips
    if len(visit_ips) > 5000:
        visit_ips = {ip: ts for ip, ts in visit_ips.items() if now - ts < 60}

    if client_ip in visit_ips and now - visit_ips[client_ip] < 60:
        raise HTTPException(status_code=429, detail="Too Many Requests")
    visit_ips[client_ip] = now

    try:
        supabase.table("site_visits").insert({"visited_at": date.today().isoformat()}).execute()
        return {"status": "ok"}
    except Exception:
        return {"status": "error"}


@app.get("/api/admin/check")
def check_admin(req_client: Client = Depends(get_admin_user)):
    return {"status": "ok", "is_admin": True}


@app.get("/api/admin/stats")
def get_admin_stats(req_client: Client = Depends(get_admin_user)):
    try:
        visits_resp = req_client.table("site_visits").select("id", count="exact").execute()
        visits_count = visits_resp.count or 0
        
        try:
            # Optimal way: count from a dedicated profiles table
            users_resp = req_client.table("profiles").select("id", count="exact").execute()
            unique_users = users_resp.count or 0
        except Exception:
            # Fallback: count distinct users in events if profiles table is not yet created
            users_resp = req_client.table("events").select("user_id").execute()
            unique_users = len(set([row.get("user_id") for row in users_resp.data if row.get("user_id")])) if users_resp.data else 0

        return {"status": "ok", "data": {"visits": visits_count, "users": unique_users}}
    except Exception:
        logger.exception("Error getting stats")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.get("/api/admin/list")
def get_admin_list(req_client: Client = Depends(get_admin_user)):
    try:
        resp = req_client.table("admin_users").select("email").execute()
        admins = [row["email"] for row in resp.data]
        return {"status": "ok", "data": admins}
    except Exception:
        raise HTTPException(status_code=500, detail="Lỗi lấy danh sách Admin")


@app.get("/api/admin/all_users")
def get_all_users(req_client: Client = Depends(get_admin_user)):
    try:
        # Fetch from profiles table
        resp = req_client.table("profiles").select("email, full_name, created_at").order("created_at", desc=True).execute()
        return {"status": "ok", "data": resp.data or []}
    except Exception:
        # Fallback if profiles is somehow empty or errors out
        return {"status": "ok", "data": []}



@app.post("/api/admin/add")
def add_admin(payload: AdminAdd, req_client: Client = Depends(get_admin_user)):
    try:
        email = payload.email.strip().lower()
        if not email:
            raise HTTPException(status_code=400, detail="Email không được trống")
            
        # Kiểm tra xem đã tồn tại chưa
        check = req_client.table("admin_users").select("email").eq("email", email).execute()
        if check.data:
            raise HTTPException(status_code=400, detail="Email này đã là Admin")
            
        req_client.table("admin_users").insert({"email": email}).execute()
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Lỗi khi thêm Admin")


@app.delete("/api/admin/remove/{email}")
def remove_admin(email: str, req_client: Client = Depends(get_admin_user)):
    try:
        target_email = email.strip().lower()
        if target_email == req_client.user_email.lower():
             raise HTTPException(status_code=400, detail="Bạn không thể tự xóa quyền của chính mình")
             
        req_client.table("admin_users").delete().eq("email", target_email).execute()
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Lỗi khi xóa Admin")


@app.get("/api/events")
def get_events(person: str | None = None, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        query = req_client.table("events").select("*, event_items(*)").eq("user_id", user_id)
        if person and person != "All":
            query = query.eq("person", person)
        query = query.order("event_date", desc=True)
        response = query.execute()
        filtered_data = [
            item for item in (response.data or []) if item.get("title") != "__person_placeholder__"
        ]
        return {"status": "ok", "data": filtered_data}
    except Exception:
        logger.exception("Error getting events")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.get("/api/people")
def get_people(req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        response = req_client.table("events").select("person").eq("user_id", user_id).execute()
        people = [item.get("person") for item in (response.data or []) if item.get("person")]
        unique_people = sorted(set(people))
        return {"status": "ok", "data": unique_people}
    except Exception:
        logger.exception("Error getting people")
        raise HTTPException(status_code=500, detail="Internal Server Error")


def create_person(payload: PersonCreate, req_client: Client | None = None):
    resolved_client = req_client if req_client is not None else globals().get("supabase")
    if resolved_client is None:
        raise RuntimeError("Supabase client is not configured")

    user_id = getattr(resolved_client, "user_id", None) or "default-user"
    try:
        person_name = payload.name.strip()
        if not person_name:
            raise HTTPException(status_code=400, detail="Tên người không được để trống")

        resolved_client.table("events").insert(
            {
                "title": "__person_placeholder__",
                "event_date": date.today().strftime("%Y-%m-%d"),
                "pay_status": "unpaid",
                "payment_method": "-",
                "actual_pay_date": None,
                "person": person_name,
                "user_id": user_id,
            }
        ).execute()
        return {"status": "ok", "data": {"name": person_name}}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error creating person")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.post("/api/people", status_code=201)
def create_person_endpoint(payload: PersonCreate, req_client: Client = Depends(get_auth_client)):
    return create_person(payload, req_client=req_client)


def delete_person(person_name: str, req_client: Client | None = None):
    resolved_client = req_client if req_client is not None else globals().get("supabase")
    if resolved_client is None:
        raise RuntimeError("Supabase client is not configured")

    user_id = getattr(resolved_client, "user_id", None) or "default-user"
    try:
        normalized_name = person_name.strip()
        if not normalized_name:
            raise HTTPException(status_code=400, detail="Tên người không được để trống")

        events_resp = resolved_client.table("events").select("id").eq("person", normalized_name).eq("user_id", user_id).execute()
        if events_resp.data:
            event_ids = [e["id"] for e in events_resp.data]
            resolved_client.table("event_items").delete().in_("event_id", event_ids).execute()

        resolved_client.table("events").delete().eq("person", normalized_name).eq("user_id", user_id).execute()
        return {"status": "ok", "message": f"Đã xóa người {normalized_name}"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error deleting person")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.delete("/api/people/{person_name}")
def delete_person_endpoint(person_name: str, req_client: Client = Depends(get_auth_client)):
    return delete_person(person_name, req_client=req_client)


@app.post("/api/events", status_code=201)
def create_event(payload: EventCreate, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        payment_method = payload.payment_method.strip() if payload.payment_method else "-"
        response = (
            req_client.table("events")
            .insert(
                {
                    "title": payload.title,
                    "event_date": payload.event_date,
                    "pay_status": payload.pay_status,
                    "payment_method": payment_method,
                    "actual_pay_date": payload.actual_pay_date,
                    "person": payload.person,
                    "debt_type": payload.debt_type,
                    "user_id": user_id,
                }
            )
            .execute()
        )
        return {"status": "ok", "data": response.data[0] if response.data else None}
    except Exception:
        logger.exception("Error creating event")
        raise HTTPException(status_code=500, detail="Internal Server Error")


def create_item(payload: ItemCreate, req_client: Client | None = None, user_id: str | None = None):
    resolved_client = req_client if req_client is not None else globals().get("supabase")
    if resolved_client is None:
        raise RuntimeError("Supabase client is not configured")

    actual_user_id = user_id or getattr(resolved_client, "user_id", None) or "default-user"
    try:
        ensure_event_owned_by_user(resolved_client, payload.event_id, actual_user_id)

        response = (
            resolved_client.table("event_items")
            .insert(
                {
                    "event_id": payload.event_id,
                    "description": payload.description,
                    "amount": payload.amount,
                }
            )
            .execute()
        )
        return {"status": "ok", "data": response.data[0] if response.data else None}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error creating item")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.post("/api/items", status_code=201)
def create_item_endpoint(payload: ItemCreate, req_client: Client = Depends(get_auth_client)):
    return create_item(payload, req_client=req_client)


@app.delete("/api/events/{event_id}")
def delete_event(event_id: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        req_client.table("event_items").delete().eq("event_id", event_id).execute()
        req_client.table("events").delete().eq("id", event_id).eq("user_id", user_id).execute()
        return {"status": "ok", "message": f"Đã xóa sự kiện {event_id}"}
    except Exception:
        logger.exception("Error deleting event")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.put("/api/events/{event_id}")
def update_event(event_id: str, payload: EventUpdate, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        update_data = {k: v for k, v in payload.model_dump(exclude_none=True).items() if v is not None}
        if not update_data:
            return {"status": "ok", "message": "No data to update"}
        
        response = req_client.table("events").update(update_data).eq("id", event_id).eq("user_id", user_id).execute()
        return {"status": "ok", "data": response.data[0] if response.data else None}
    except Exception:
        logger.exception("Error updating event")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.put("/api/items/{item_id}")
def update_item(item_id: str, payload: ItemUpdate, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        ensure_item_owned_by_user(req_client, item_id, user_id)

        update_data = {k: v for k, v in payload.model_dump(exclude_none=True).items() if v is not None}
        if not update_data:
            return {"status": "ok", "message": "No data to update"}

        response = req_client.table("event_items").update(update_data).eq("id", item_id).execute()
        return {"status": "ok", "data": response.data[0] if response.data else None}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error updating item")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.delete("/api/items/{item_id}")
def delete_item(item_id: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        ensure_item_owned_by_user(req_client, item_id, user_id)

        req_client.table("event_items").delete().eq("id", item_id).execute()
        return {"status": "ok", "message": f"Deleted item {item_id}"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error deleting item")
        raise HTTPException(status_code=500, detail="Internal Server Error")


class ToggleStatusPayload(BaseModel):
    client_date: str | None = None  # YYYY-MM-DD gửi từ trình duyệt của người dùng

    _validate_date = field_validator("client_date")(validate_date_format)


@app.put("/api/events/{event_id}/toggle-status")
def toggle_status(event_id: str, payload: ToggleStatusPayload = ToggleStatusPayload(), req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        current = (
            req_client.table("events")
            .select("pay_status")
            .eq("id", event_id)
            .eq("user_id", user_id)
            .execute()
        )
        if not current.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy sự kiện")

        current_status = current.data[0].get("pay_status", "unpaid")
        new_status = "paid" if current_status == "unpaid" else "unpaid"
        
        # Sử dụng ngày do trình duyệt của người dùng gửi lên để đúng múi giờ của họ
        # (tránh trường hợp server UTC trả về ngày khác với người dùng VN hay Mỹ)
        if new_status == "paid":
            new_actual_pay_date = payload.client_date or date.today().strftime("%Y-%m-%d")
        else:
            new_actual_pay_date = None

        response = (
            req_client.table("events")
            .update(
                {
                    "pay_status": new_status,
                    "actual_pay_date": new_actual_pay_date,
                }
            )
            .eq("id", event_id)
            .eq("user_id", user_id)
            .execute()
        )
        return {"status": "ok", "data": response.data[0] if response.data else None}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error toggling status")
        raise HTTPException(status_code=500, detail="Internal Server Error")

