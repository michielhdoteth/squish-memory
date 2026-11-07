DO $$
DECLARE
  had_confidence_level boolean;
  had_importance_score boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'memories' AND column_name = 'confidence_level'
  ) INTO had_confidence_level;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'memories' AND column_name = 'importance_score'
  ) INTO had_importance_score;

  ALTER TABLE "memories"
    ADD COLUMN IF NOT EXISTS "confidence_level" text NOT NULL DEFAULT 'speculative';
  ALTER TABLE "memories"
    ADD COLUMN IF NOT EXISTS "importance_score" integer NOT NULL DEFAULT 50;

  IF NOT had_confidence_level OR NOT had_importance_score THEN
    UPDATE "memories" AS source
    SET "confidence_level" = COALESCE(projection."confidence_level", 'speculative'),
        "importance_score" = round(COALESCE(projection."importance_score", 0.5) * 100)::integer
    FROM "knowledge" AS projection
    WHERE projection."knowledge_kind" = 'memory'
      AND projection."metadata"->>'sourceMemoryId' = source."id"::text;
  END IF;
END $$;
