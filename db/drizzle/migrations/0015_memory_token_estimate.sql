ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "tokens_estimate" integer NOT NULL DEFAULT 0;
