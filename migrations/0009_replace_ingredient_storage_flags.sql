ALTER TABLE ingredients ADD COLUMN storage_location TEXT
  CHECK (storage_location IN ('pantry', 'refrigerator', 'freezer'));

UPDATE ingredients
SET storage_location = CASE
  WHEN refrigerated = 1 THEN 'refrigerator'
  WHEN shelf_stable = 1 THEN 'pantry'
  ELSE NULL
END
WHERE storage_location IS NULL;

ALTER TABLE ingredients DROP COLUMN refrigerated;
ALTER TABLE ingredients DROP COLUMN shelf_stable;
