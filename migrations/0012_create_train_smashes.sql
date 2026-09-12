CREATE TABLE train_smashes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_json TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX train_smashes_user_created ON train_smashes(user_id, created_at DESC);
