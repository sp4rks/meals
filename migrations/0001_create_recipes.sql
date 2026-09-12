CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  source_site TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  ingredients_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'needs_review')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_site, source_id)
);

CREATE INDEX IF NOT EXISTS recipes_status_title_idx
  ON recipes (status, title COLLATE NOCASE);
