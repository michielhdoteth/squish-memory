CREATE TABLE IF NOT EXISTS "memory_capture_receipts" (
  "capture_key_hash" text PRIMARY KEY,
  "content_hash" text NOT NULL,
  "memory_id" uuid NOT NULL UNIQUE REFERENCES "memories"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "memory_capture_receipts_memory_idx"
  ON "memory_capture_receipts" ("memory_id");
