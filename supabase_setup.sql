-- Chạy đoạn script này trong mục SQL Editor của Supabase Dashboard

-- 1. Create the food_reviews table
CREATE TABLE IF NOT EXISTS food_reviews (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users NOT NULL,
  restaurant_name text NOT NULL,
  address text,
  food_name text NOT NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text text,
  image_url text NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Ensure address column exists in case the table was created before it was added
ALTER TABLE food_reviews ADD COLUMN IF NOT EXISTS address text;

-- Ensure price column exists
ALTER TABLE food_reviews ADD COLUMN IF NOT EXISTS price numeric;

-- 2. Setup Row Level Security (RLS) for food_reviews table
ALTER TABLE food_reviews ENABLE ROW LEVEL SECURITY;

-- Allow everyone to view food reviews
DROP POLICY IF EXISTS "Users can view their own food reviews" ON food_reviews;
DROP POLICY IF EXISTS "Everyone can view food reviews" ON food_reviews;
CREATE POLICY "Everyone can view food reviews"
  ON food_reviews
  FOR SELECT
  USING (true);

-- Allow users to insert their own reviews
DROP POLICY IF EXISTS "Users can insert their own food reviews" ON food_reviews;
CREATE POLICY "Users can insert their own food reviews"
  ON food_reviews
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Allow users to delete their own reviews
DROP POLICY IF EXISTS "Users can delete their own food reviews" ON food_reviews;
CREATE POLICY "Users can delete their own food reviews"
  ON food_reviews
  FOR DELETE
  USING (auth.uid() = user_id);

-- 3. Create the storage bucket (If not created via UI)
-- (Lưu ý: Storage buckets thường được tạo qua UI cho dễ, nhưng nếu dùng SQL thì dùng lệnh dưới)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('food_reviews', 'food_reviews', true)
ON CONFLICT (id) DO NOTHING;

-- 4. Setup Storage RLS Policies for food_reviews bucket
-- Cho phép mọi người xem ảnh (public)
DROP POLICY IF EXISTS "Public Access" ON storage.objects;
CREATE POLICY "Public Access" 
  ON storage.objects FOR SELECT 
  USING (bucket_id = 'food_reviews');

-- Chỉ cho phép user đã đăng nhập upload ảnh vào thư mục của họ
DROP POLICY IF EXISTS "Authenticated users can upload images" ON storage.objects;
CREATE POLICY "Authenticated users can upload images" 
  ON storage.objects FOR INSERT 
  WITH CHECK (
    bucket_id = 'food_reviews' AND 
    auth.role() = 'authenticated' AND 
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Chỉ cho phép user xóa ảnh của chính họ
DROP POLICY IF EXISTS "Users can delete their own images" ON storage.objects;
CREATE POLICY "Users can delete their own images" 
  ON storage.objects FOR DELETE 
  USING (
    bucket_id = 'food_reviews' AND 
    auth.role() = 'authenticated' AND 
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- 5. Reload Schema Cache (Fixes "Could not find column in schema cache" error)
NOTIFY pgrst, reload_schema;
