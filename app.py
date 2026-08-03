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
from fastapi.staticfiles import StaticFiles
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
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY") or SUPABASE_KEY

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Thiếu SUPABASE_URL hoặc SUPABASE_KEY trong .env")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI(title="Debt Tracker API", version="4.0.0")

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True if ALLOWED_ORIGINS != ["*"] else False,
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
    title: str = Field(..., max_length=150)
    event_date: str = Field(..., max_length=20)
    payment_method: str = Field("-", max_length=50)
    person: str = Field(..., max_length=100)
    debt_type: str = Field("borrow", max_length=20)
    pay_status: str = Field("unpaid", max_length=20)
    actual_pay_date: str | None = Field(None, max_length=20)

    _validate_date = field_validator("event_date", "actual_pay_date")(validate_date_format)


class ItemCreate(BaseModel):
    event_id: str = Field(..., max_length=50)
    description: str = Field(..., max_length=200)
    amount: float = Field(description="Amount of the item, can be negative for offset")


class EventUpdate(BaseModel):
    title: str | None = Field(None, max_length=150)
    event_date: str | None = Field(None, max_length=20)
    payment_method: str | None = Field(None, max_length=50)
    debt_type: str | None = Field(None, max_length=20)
    pay_status: str | None = Field(None, max_length=20)
    actual_pay_date: str | None = Field(None, max_length=20)

    _validate_date = field_validator("event_date", "actual_pay_date")(validate_date_format)


class ItemUpdate(BaseModel):
    description: str | None = Field(None, max_length=200)
    amount: float | None = Field(default=None, description="Amount of the item, can be negative for offset")


class DailyHabitCreate(BaseModel):
    title: str = Field(..., max_length=200)


class HabitCompletionToggle(BaseModel):
    is_completed: bool
    task_date: str = Field(..., max_length=20)

    _validate_date = field_validator("task_date")(validate_date_format)


class PersonCreate(BaseModel):
    name: str = Field(..., max_length=100)


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


@app.get("/style.css")
def get_style():
    return FileResponse(os.path.join(os.path.dirname(__file__), "style.css"))


@app.get("/app.js")
def get_app_js():
    return FileResponse(os.path.join(os.path.dirname(__file__), "app.js"))


@app.get("/manifest.json")
def get_manifest():
    return FileResponse(os.path.join(os.path.dirname(__file__), "manifest.json"))


@app.get("/sw.js")
def get_sw():
    return FileResponse(os.path.join(os.path.dirname(__file__), "sw.js"))


app.mount("/libs", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "libs")), name="libs")


@app.get("/api/config")
def get_config():
    return {
        "supabaseUrl": SUPABASE_URL,
        "supabaseKey": SUPABASE_ANON_KEY
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
        ensure_event_owned_by_user(req_client, event_id, user_id)
        req_client.table("event_items").delete().eq("event_id", event_id).execute()
        req_client.table("events").delete().eq("id", event_id).eq("user_id", user_id).execute()
        return {"status": "ok", "message": f"Đã xóa sự kiện {event_id}"}
    except HTTPException:
        raise
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


# ==========================================
# DAILY TASKS APIS
# ==========================================

@app.get("/api/daily-tasks")
def get_daily_tasks(date: str | None = None, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        from datetime import date as dt_date
        target_date = date or dt_date.today().strftime("%Y-%m-%d")
        
        habits_resp = req_client.table("daily_habits").select("*").eq("user_id", user_id).order("created_at").execute()
        habits = habits_resp.data or []
        
        comps_resp = req_client.table("daily_habit_completions").select("*").eq("user_id", user_id).eq("task_date", target_date).execute()
        completions = {c['habit_id']: c['is_completed'] for c in (comps_resp.data or [])}
        
        merged = []
        for h in habits:
            merged.append({
                "id": h['id'],
                "title": h['title'],
                "is_completed": completions.get(h['id'], False)
            })
            
        return {"status": "ok", "data": merged}
    except Exception:
        logger.exception("Error getting daily tasks")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.get("/api/daily-tasks/stats")
def get_daily_tasks_stats(req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        from datetime import date as dt_date, timedelta, datetime
        
        habits_resp = req_client.table("daily_habits").select("id").eq("user_id", user_id).execute()
        total_habits = len(habits_resp.data or [])

        # Fetch completions that are True
        response = req_client.table("daily_habit_completions").select("task_date").eq("user_id", user_id).eq("is_completed", True).execute()
        completions = response.data or []
        
        date_stats = {}
        total_tasks_completed = 0
        for c in completions:
            d = c['task_date']
            if d not in date_stats:
                date_stats[d] = 0
            date_stats[d] += 1
            total_tasks_completed += 1
                
        completed_dates = set()
        for d, count in date_stats.items():
            if count == total_habits and total_habits > 0:
                completed_dates.add(d)
                
        today = dt_date.today()
        
        def calculate_streak(start_date):
            streak = 0
            curr_date = start_date
            while curr_date.strftime("%Y-%m-%d") in completed_dates:
                streak += 1
                curr_date -= timedelta(days=1)
            return streak

        current_streak = 0
        if today.strftime("%Y-%m-%d") in completed_dates:
            current_streak = calculate_streak(today)
        else:
            yesterday = today - timedelta(days=1)
            if yesterday.strftime("%Y-%m-%d") in completed_dates:
                current_streak = calculate_streak(yesterday)
                
        longest_streak = 0
        visited = set()
        for d_str in completed_dates:
            if d_str in visited:
                continue
            d_obj = datetime.strptime(d_str, "%Y-%m-%d").date()
            next_day = d_obj + timedelta(days=1)
            if next_day.strftime("%Y-%m-%d") in completed_dates:
                continue
            
            streak = 0
            curr_date = d_obj
            while curr_date.strftime("%Y-%m-%d") in completed_dates:
                visited.add(curr_date.strftime("%Y-%m-%d"))
                streak += 1
                curr_date -= timedelta(days=1)
                
            if streak > longest_streak:
                longest_streak = streak
                
        return {
            "status": "ok", 
            "data": {
                "current_streak": current_streak,
                "longest_streak": longest_streak,
                "total_completed": total_tasks_completed
            }
        }
    except Exception:
        logger.exception("Error calculating daily tasks stats")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.post("/api/daily-tasks", status_code=201)
def create_daily_task(payload: DailyHabitCreate, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        response = (
            req_client.table("daily_habits")
            .insert(
                {
                    "title": payload.title,
                    "user_id": user_id,
                }
            )
            .execute()
        )
        return {"status": "ok", "data": response.data[0] if response.data else None}
    except Exception:
        logger.exception("Error creating daily habit")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.put("/api/daily-tasks/{habit_id}")
def update_daily_task(habit_id: str, payload: HabitCompletionToggle, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        # Upsert the completion record
        response = req_client.table("daily_habit_completions").upsert({
            "habit_id": habit_id,
            "user_id": user_id,
            "task_date": payload.task_date,
            "is_completed": payload.is_completed
        }, on_conflict="habit_id,task_date").execute()
        
        return {"status": "ok", "data": response.data[0] if response.data else None}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error updating daily habit completion")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.delete("/api/daily-tasks/{habit_id}")
def delete_daily_task(habit_id: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        response = req_client.table("daily_habits").delete().eq("id", habit_id).eq("user_id", user_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Task not found")
        return {"status": "ok", "message": "Task deleted"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error deleting daily habit")
        raise HTTPException(status_code=500, detail="Internal Server Error")


# ==========================================
# SHARE FEATURE APIS
# ==========================================
import uuid

@app.get("/api/share/{person}/status")
def get_share_status(person: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        resp = req_client.table("events").select("payment_method").eq("person", person).eq("user_id", user_id).eq("title", "__person_placeholder__").execute()
        if not resp.data:
            return {"status": "ok", "is_shared": False}
        
        pm = resp.data[0].get("payment_method", "")
        if pm.startswith("share_token:"):
            token = pm.split(":", 1)[1]
            return {"status": "ok", "is_shared": True, "token": token}
        
        return {"status": "ok", "is_shared": False}
    except Exception:
        logger.exception("Error getting share status")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.post("/api/share/{person}")
def generate_share_link(person: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        # Check if placeholder exists
        resp = req_client.table("events").select("id, payment_method").eq("person", person).eq("user_id", user_id).eq("title", "__person_placeholder__").execute()
        new_token = str(uuid.uuid4().hex)
        new_pm = f"share_token:{new_token}"
        
        if not resp.data:
            # Create placeholder if it somehow doesn't exist
            req_client.table("events").insert({
                "title": "__person_placeholder__",
                "event_date": date.today().strftime("%Y-%m-%d"),
                "pay_status": "unpaid",
                "payment_method": new_pm,
                "person": person,
                "user_id": user_id,
            }).execute()
        else:
            # Update existing placeholder
            event_id = resp.data[0]["id"]
            req_client.table("events").update({"payment_method": new_pm}).eq("id", event_id).execute()
            
        return {"status": "ok", "token": new_token}
    except Exception:
        logger.exception("Error generating share link")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.delete("/api/share/{person}")
def revoke_share_link(person: str, req_client: Client = Depends(get_auth_client)):
    user_id = req_client.user_id
    try:
        resp = req_client.table("events").select("id").eq("person", person).eq("user_id", user_id).eq("title", "__person_placeholder__").execute()
        if resp.data:
            event_id = resp.data[0]["id"]
            req_client.table("events").update({"payment_method": "-"}).eq("id", event_id).execute()
        return {"status": "ok"}
    except Exception:
        logger.exception("Error revoking share link")
        raise HTTPException(status_code=500, detail="Internal Server Error")


@app.get("/api/shared/{token}")
def get_shared_data(token: str):
    try:
        # Find the placeholder event with this token
        target_pm = f"share_token:{token}"
        # We need to use the admin client since this endpoint is public
        resp = supabase.table("events").select("user_id, person").eq("title", "__person_placeholder__").eq("payment_method", target_pm).execute()
        
        if not resp.data:
            raise HTTPException(status_code=404, detail="The share link is invalid or has been revoked")
            
        user_id = resp.data[0]["user_id"]
        person = resp.data[0]["person"]
        
        # Now fetch all events for this person
        events_resp = supabase.table("events").select("*, event_items(*)").eq("user_id", user_id).eq("person", person).order("event_date", desc=True).execute()
        
        filtered_data = [
            item for item in (events_resp.data or []) if item.get("title") != "__person_placeholder__"
        ]
        
        return {
            "status": "ok", 
            "data": {
                "person": person,
                "events": filtered_data
            }
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error fetching shared data")
        raise HTTPException(status_code=500, detail="Internal Server Error")

