CREATE TABLE IF NOT EXISTS "visibility_rules" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "asset_type" text NOT NULL,
  "asset_id" text NOT NULL,
  "rule_type" text NOT NULL,
  "grantee_type" text NOT NULL,
  "grantee_id" text NOT NULL,
  "permission" text NOT NULL DEFAULT 'read',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "visibility_rules_asset_idx" ON "visibility_rules" ("asset_type", "asset_id");
CREATE INDEX IF NOT EXISTS "visibility_rules_grantee_idx" ON "visibility_rules" ("grantee_type", "grantee_id");
CREATE UNIQUE INDEX IF NOT EXISTS "visibility_rules_unique" ON "visibility_rules" ("asset_type", "asset_id", "grantee_type", "grantee_id");
