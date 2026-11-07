ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS "memories_status_lifecycle_idx"
  ON "memories" ("status", "is_active", "expires_at");
