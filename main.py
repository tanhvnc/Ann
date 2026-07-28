"""
main.py - Test kết nối Supabase
Import client từ database.py và thử thực hiện một truy vấn mẫu.
"""

from database import supabase


def test_connection():
    """
    Test kết nối bằng cách thử fetch dữ liệu từ một bảng mẫu.
    Nếu bảng chưa tồn tại, sẽ thông báo cho người dùng.
    """
    print("\n🔍 Đang test kết nối Supabase...\n")

    try:
        # Thử liệt kê dữ liệu từ bảng "test" (bảng mẫu)
        # Nếu bảng chưa tồn tại, Supabase sẽ trả về lỗi - đó là bình thường
        response = supabase.table("test").select("*").limit(5).execute()

        print(f"✅ Truy vấn thành công!")
        print(f"   Số bản ghi nhận được: {len(response.data)}")

        if response.data:
            print(f"   Dữ liệu mẫu: {response.data}")
        else:
            print("   ℹ️  Bảng 'test' trống hoặc chưa có dữ liệu.")

    except Exception as e:
        error_msg = str(e)
        if "relation" in error_msg and "does not exist" in error_msg:
            print("⚠️  Bảng 'test' chưa tồn tại trong database.")
            print("   Đây là bình thường nếu bạn chưa tạo bảng.")
            print("   → Hãy vào Supabase Dashboard để tạo bảng 'test' và thử lại.")
        else:
            print(f"❌ Lỗi khi truy vấn: {e}")

    print("\n" + "=" * 50)
    print("🎉 Test kết nối hoàn tất!")
    print("=" * 50)


if __name__ == "__main__":
    test_connection()
