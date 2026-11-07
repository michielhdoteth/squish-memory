DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_edges_valid_interval'
      AND conrelid = 'knowledge_edges'::regclass
  ) THEN
    ALTER TABLE "knowledge_edges"
      ADD CONSTRAINT "knowledge_edges_valid_interval"
      CHECK ("valid_to" IS NULL OR ("valid_from" IS NOT NULL AND "valid_to" > "valid_from"))
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_edges_recorded_interval'
      AND conrelid = 'knowledge_edges'::regclass
  ) THEN
    ALTER TABLE "knowledge_edges"
      ADD CONSTRAINT "knowledge_edges_recorded_interval"
      CHECK ("recorded_to" IS NULL OR ("recorded_at" IS NOT NULL AND "recorded_to" > "recorded_at"))
      NOT VALID;
  END IF;
END $$;

ALTER TABLE "knowledge_edges" VALIDATE CONSTRAINT "knowledge_edges_valid_interval";
ALTER TABLE "knowledge_edges" VALIDATE CONSTRAINT "knowledge_edges_recorded_interval";
