ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "mention_count" integer DEFAULT 0;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "last_mentioned_at" timestamp;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "aliases" jsonb;
