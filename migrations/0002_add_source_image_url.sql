ALTER TABLE recipes ADD COLUMN source_image_url TEXT NOT NULL DEFAULT '';

UPDATE recipes
SET source_image_url = image_url
WHERE source_image_url = '' AND image_url != '';
