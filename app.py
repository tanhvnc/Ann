"""
app.py - FastAPI Backend cho Debt Tracker (Hỗ trợ Supabase Auth)
"""

import os
from datetime import date
from dotenv import load_dotenv
import logging
import re
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from supabase import Client, create_client, ClientOptions

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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

    _validate_date = field_validator("event_date")(validate_date_format)


class ItemCreate(BaseModel):
    event_id: str
    description: str
    amount: float = Field(gt=0, description="Amount must be greater than zero")


class EventUpdate(BaseModel):
    title: str | None = None
    event_date: str | None = None
    payment_method: str | None = None
    debt_type: str | None = None

    _validate_date = field_validator("event_date")(validate_date_format)


class ItemUpdate(BaseModel):
    description: str | None = None
    amount: float | None = Field(default=None, gt=0, description="Amount must be greater than zero")


class PersonCreate(BaseModel):
    name: str


class AdminAdd(BaseModel):
    email: str


def get_admin_user(req_client: Client = Depends(get_auth_client)):
    user_email = getattr(req_client, "user_email", None)
    if not user_email:
         raise HTTPException(status_code=403, detail="Forbidden")
    
    try:
         resp = supabase.table("admin_users").select("*").eq("email", user_email).execute()
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


@app.post("/api/visits")
def record_visit():
    try:
        supabase.table("site_visits").insert({"visited_at": date.today().isoformat()}).execute()
        return {"status": "ok"}
    except Exception:
        # Ignore errors for visit tracking so it doesn't break frontend
        return {"status": "error"}


@app.get("/api/admin/check")
def check_admin(req_client: Client = Depends(get_admin_user)):
    return {"status": "ok", "is_admin": True}


@app.get("/api/admin/stats")
def get_admin_stats(req_client: Client = Depends(get_admin_user)):
    try:
        visits_resp = supabase.table("site_visits").select("id", count="exact").execute()
        visits_count = visits_resp.count or 0
        
        users_resp = supabase.table("events").select("user_id").execute()
        unique_users = len(set([row.get("user_id") for row in users_resp.data if row.get("user_id")])) if users_resp.data else 0

        return {"status": "ok", "data": {"visits": visits_count, "users": unique_users}}
    except Exception:
        logger.exception("Error getting stats")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.get("/api/admin/list")
def get_admin_list(req_client: Client = Depends(get_admin_user)):
    try:
        resp = supabase.table("admin_users").select("email").execute()
        admins = [row["email"] for row in resp.data]
        return {"status": "ok", "data": admins}
    except Exception:
        raise HTTPException(status_code=500, detail="Lỗi lấy danh sách Admin")


@app.post("/api/admin/add")
def add_admin(payload: AdminAdd, req_client: Client = Depends(get_admin_user)):
    try:
        email = payload.email.strip().lower()
        if not email:
            raise HTTPException(status_code=400, detail="Email không được trống")
            
        # Kiểm tra xem đã tồn tại chưa
        check = supabase.table("admin_users").select("email").eq("email", email).execute()
        if check.data:
            raise HTTPException(status_code=400, detail="Email này đã là Admin")
            
        supabase.table("admin_users").insert({"email": email}).execute()
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
             
        supabase.table("admin_users").delete().eq("email", target_email).execute()
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


@app.post("/api/people", status_code=201)
def create_person(payload: PersonCreate, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        person_name = payload.name.strip()
        if not person_name:
            raise HTTPException(status_code=400, detail="Tên người không được để trống")

        response = (
            req_client.table("events")
            .insert(
                {
                    "title": "__person_placeholder__",
                    "event_date": date.today().strftime("%Y-%m-%d"),
                    "pay_status": "unpaid",
                    "payment_method": "-",
                    "actual_pay_date": None,
                    "person": person_name,
                    "user_id": user_id,
                }
            )
            .execute()
        )
        return {"status": "ok", "data": {"name": person_name}}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error creating person")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.delete("/api/people/{person_name}")
def delete_person(person_name: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        normalized_name = person_name.strip()
        if not normalized_name:
            raise HTTPException(status_code=400, detail="Tên người không được để trống")

        req_client.table("events").delete().eq("person", normalized_name).eq("user_id", user_id).execute()
        return {"status": "ok", "message": f"Đã xóa người {normalized_name}"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error deleting person")
        raise HTTPException(status_code=500, detail="Internal Server Error")


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
                    "pay_status": "unpaid",
                    "payment_method": payment_method,
                    "actual_pay_date": None,
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


@app.post("/api/items", status_code=201)
def create_item(payload: ItemCreate, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        ensure_event_owned_by_user(req_client, payload.event_id, user_id)

        response = (
            req_client.table("event_items")
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


@app.delete("/api/events/{event_id}")
def delete_event(event_id: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
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


@app.put("/api/events/{event_id}/toggle-status")
def toggle_status(event_id: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        current = (
            req_client.table("events")
            .select("pay_status")
            .eq("id", event_id)
            .eq("user_id", user_id)
            .single()
            .execute()
        )
        if not current.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy sự kiện")

        current_status = current.data.get("pay_status", "unpaid")
        new_status = "paid" if current_status == "unpaid" else "unpaid"
        new_actual_pay_date = date.today().strftime("%Y-%m-%d") if new_status == "paid" else None

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

