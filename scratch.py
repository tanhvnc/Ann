import re

with open('d:/testproject/app.py', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Update imports
code = code.replace('from supabase import Client, create_client', 'from supabase import Client, create_client, ClientOptions')

# 2. Update get_current_user_id to get_auth_client
old_auth_func = '''def get_current_user_id(authorization: str | None = Header(None)) -> str:
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
        return str(user_res.user.id)
    except Exception as exc:
        logger.error(f"Auth error: {exc}")
        raise HTTPException(status_code=401, detail="Xác thực thất bại")'''

new_auth_func = '''def get_auth_client(authorization: str | None = Header(None)) -> Client:
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
        return req_client
    except Exception as exc:
        logger.error(f"Auth error: {exc}")
        raise HTTPException(status_code=401, detail="Xác thực thất bại")'''

code = code.replace(old_auth_func, new_auth_func)

# 3. Update ensure_ functions
old_ensure = '''def ensure_event_owned_by_user(event_id: str, user_id: str) -> None:
    event_check = supabase.table("events").select("id").eq("id", event_id).eq("user_id", user_id).execute()
    if not event_check.data:
        raise HTTPException(status_code=403, detail="Event not found or unauthorized")


def ensure_item_owned_by_user(item_id: str, user_id: str) -> str:
    item_check = supabase.table("event_items").select("event_id").eq("id", item_id).execute()
    if not item_check.data:
        raise HTTPException(status_code=404, detail="Item not found")

    event_id = item_check.data[0].get("event_id")
    if not event_id:
        raise HTTPException(status_code=404, detail="Item not found")

    ensure_event_owned_by_user(event_id, user_id)
    return event_id'''

new_ensure = '''def ensure_event_owned_by_user(req_client: Client, event_id: str, user_id: str) -> None:
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
    return event_id'''

code = code.replace(old_ensure, new_ensure)

# 4. Replace dependency injection in endpoints
code = re.sub(r'user_id:\s*str\s*=\s*Depends\(get_current_user_id\)', r'req_client: Client = Depends(get_auth_client)', code)

# 5. Insert user_id = req_client.user_id and replace supabase with req_client in functions
endpoints = ['get_events', 'get_people', 'create_person', 'delete_person', 'create_event', 'create_item', 'delete_event', 'update_event', 'update_item', 'delete_item', 'toggle_status']

for ep in endpoints:
    pattern = rf'def {ep}\(.*?\):.*?(?=\n@app|\Z)'
    match = re.search(pattern, code, re.DOTALL)
    if match:
        old_ep = match.group(0)
        new_ep = old_ep.replace('supabase.', 'req_client.')
        # Add user_id assignment after the try: 
        if 'try:' in new_ep:
            new_ep = new_ep.replace('try:', 'user_id = req_client.user_id\n    try:', 1)
        new_ep = new_ep.replace('ensure_event_owned_by_user(payload.event_id, user_id)', 'ensure_event_owned_by_user(req_client, payload.event_id, user_id)')
        new_ep = new_ep.replace('ensure_item_owned_by_user(item_id, user_id)', 'ensure_item_owned_by_user(req_client, item_id, user_id)')
        code = code.replace(old_ep, new_ep)

with open('d:/testproject/app.py', 'w', encoding='utf-8') as f:
    f.write(code)

print('Refactored app.py successfully')
