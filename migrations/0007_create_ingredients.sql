CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  category TEXT,
  default_unit TEXT,
  refrigerated INTEGER CHECK (refrigerated IN (0, 1)),
  shelf_stable INTEGER CHECK (shelf_stable IN (0, 1)),
  storage_notes TEXT NOT NULL DEFAULT '',
  enrichment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (enrichment_status IN ('pending', 'complete', 'needs_review', 'failed')),
  enrichment_notes TEXT NOT NULL DEFAULT '',
  enriched_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ingredients_name_idx
  ON ingredients (name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS ingredients_enrichment_status_idx
  ON ingredients (enrichment_status);
