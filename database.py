"""
database.py - Module kết nối Supabase
Đọc cấu hình từ file .env và khởi tạo Supabase Client.
"""

import os
import sys
from dotenv import load_dotenv
from supabase import create_client, Client


def get_supabase_client() -> Client:
    """
    Đọc biến môi trường từ file .env và khởi tạo Supabase Client.

    Returns:
        Client: Supabase client object đã được khởi tạo.

    Raises:
        SystemExit: Nếu thiếu biến môi trường hoặc không thể kết nối.
    """
    # Load biến môi trường từ file .env
    load_dotenv()

    supabase_url: str | None = os.getenv("SUPABASE_URL")
    supabase_key: str | None = os.getenv("SUPABASE_KEY")

    # Kiểm tra biến môi trường đã được cấu hình chưa
    if not supabase_url or not supabase_key:
        print("❌ Lỗi: Thiếu SUPABASE_URL hoặc SUPABASE_KEY trong file .env")
        print("   Vui lòng kiểm tra lại file .env và điền đầy đủ thông tin.")
        sys.exit(1)

    try:
        client: Client = create_client(supabase_url, supabase_key)
        print("✅ Kết nối Supabase Client thành công!")
        return client
    except Exception as e:
        print(f"❌ Lỗi khi khởi tạo Supabase Client: {e}")
        sys.exit(1)


# Khởi tạo client sẵn để các module khác có thể import trực tiếp
# Ví dụ: from database import supabase
supabase: Client = get_supabase_client()
