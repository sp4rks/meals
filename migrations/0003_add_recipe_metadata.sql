ALTER TABLE recipes ADD COLUMN cook_time_from INTEGER;
ALTER TABLE recipes ADD COLUMN cook_time_to INTEGER;
ALTER TABLE recipes ADD COLUMN cook_time_unit TEXT NOT NULL DEFAULT 'minutes';
ALTER TABLE recipes ADD COLUMN difficulty TEXT NOT NULL DEFAULT '';
ALTER TABLE recipes ADD COLUMN macros_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE recipes ADD COLUMN allergens_json TEXT NOT NULL DEFAULT '[]';
