ALTER TABLE train_smashes ADD COLUMN parent_id TEXT REFERENCES train_smashes(id) ON DELETE SET NULL;
CREATE INDEX train_smashes_parent ON train_smashes(parent_id);
