CREATE TABLE IF NOT EXISTS recipe_cooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cooked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS recipe_cooks_recipe_cooked_idx
  ON recipe_cooks (recipe_id, cooked_at DESC, id DESC);
