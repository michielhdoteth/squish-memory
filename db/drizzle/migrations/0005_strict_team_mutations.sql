DO $$ BEGIN
  CREATE TYPE "team_member_role" AS ENUM ('owner', 'admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "teams" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "description" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "team_members" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" "team_member_role" DEFAULT 'member' NOT NULL,
  "joined_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "team_members_team_user_unique" UNIQUE ("team_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "team_members_team_idx" ON "team_members" ("team_id");
CREATE INDEX IF NOT EXISTS "team_members_user_idx" ON "team_members" ("user_id");

CREATE TABLE IF NOT EXISTS "team_invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" "team_member_role" DEFAULT 'member' NOT NULL,
  "code" text NOT NULL UNIQUE,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "team_invitations_team_idx" ON "team_invitations" ("team_id");
CREATE INDEX IF NOT EXISTS "team_invitations_code_idx" ON "team_invitations" ("code");

ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "team_id" text REFERENCES "teams"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "memories_team_idx" ON "memories" ("team_id");

CREATE TABLE IF NOT EXISTS "team_shares" (
  "id" text PRIMARY KEY NOT NULL,
  "memory_id" uuid NOT NULL REFERENCES "memories"("id") ON DELETE CASCADE,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "shared_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "permission" text DEFAULT 'read' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "team_shares_memory_team_unique" UNIQUE ("memory_id", "team_id")
);
CREATE INDEX IF NOT EXISTS "team_shares_memory_idx" ON "team_shares" ("memory_id");
CREATE INDEX IF NOT EXISTS "team_shares_team_idx" ON "team_shares" ("team_id");

CREATE TABLE IF NOT EXISTS "team_security_audit" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_hash" text NOT NULL,
  "team_hash" text NOT NULL,
  "target_hash" text,
  "action" text NOT NULL,
  "decision" text NOT NULL CHECK ("decision" IN ('allow', 'deny')),
  "reason" text NOT NULL,
  "created_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "team_security_audit_created_idx" ON "team_security_audit" ("created_at");
CREATE INDEX IF NOT EXISTS "team_security_audit_team_idx" ON "team_security_audit" ("team_hash", "created_at");
