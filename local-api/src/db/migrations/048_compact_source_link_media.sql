-- 货源链接的预览图和原图成为一等列，移除 raw_json 对同一手工链接的重复副本。
ALTER TABLE product_source_links ADD COLUMN preview_image_url TEXT;
ALTER TABLE product_source_links ADD COLUMN original_image_url TEXT;
ALTER TABLE purchase_source_links ADD COLUMN preview_image_url TEXT;
ALTER TABLE purchase_source_links ADD COLUMN original_image_url TEXT;
ALTER TABLE sales_source_links ADD COLUMN preview_image_url TEXT;
ALTER TABLE sales_source_links ADD COLUMN original_image_url TEXT;

PRAGMA user_version = 48;
