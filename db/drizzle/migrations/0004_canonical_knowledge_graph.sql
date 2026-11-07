CREATE TYPE "public"."knowledge_kind" AS ENUM('memory', 'belief', 'strategy');
CREATE TABLE "knowledge" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text,
	"user_id" text,
	"agent_id" text,
	"session_id" text,
	"knowledge_kind" "knowledge_kind" NOT NULL,
	"knowledge_type" text NOT NULL,
	"content" text NOT NULL,
	"summary" text,
	"embedding_json" text,
	"embedding" text,
	"embedding_model" text,
	"embedding_dim" integer,
	"confidence" real DEFAULT 0.5,
	"confidence_level" text DEFAULT 'certain',
	"importance_score" real DEFAULT 0.5,
	"importance_decay_rate" real DEFAULT 30,
	"last_importance_recalc" timestamp,
	"normalized_key" text,
	"reason" text,
	"evidence_summary" text,
	"evidence" jsonb,
	"last_confirmed_at" timestamp,
	"source_count" integer DEFAULT 1,
	"title" text,
	"description" text,
	"steps" text,
	"success_criteria" text,
	"failure_indicators" text,
	"usage_count" integer DEFAULT 0,
	"success_count" integer DEFAULT 0,
	"failure_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"last_success_at" timestamp,
	"last_failure_at" timestamp,
	"status" text DEFAULT 'active',
	"is_active" boolean DEFAULT true,
	"sector" text DEFAULT 'general',
	"tier" text DEFAULT 'episodic',
	"version" integer DEFAULT 1,
	"superseded_by" text,
	"contradicts_id" text,
	"informed_by_id" text,
	"tags" text,
	"metadata" jsonb,
	"place_id" text,
	"primary_place" text,
	"is_private" boolean DEFAULT false,
	"is_protected" boolean DEFAULT false,
	"is_pinned" boolean DEFAULT false,
	"is_immutable" boolean DEFAULT false,
	"write_scope" text,
	"read_scope" text,
	"scope" text DEFAULT 'company',
	"visibility_scope" text DEFAULT 'private',
	"actor_user" text,
	"actor_agent" text,
	"agent_role" text,
	"triggered_by" text,
	"capture_reason" text,
	"valid_from" timestamp,
	"valid_to" timestamp,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"access_count" integer DEFAULT 0,
	"last_accessed_at" timestamp,
	"is_merged" boolean DEFAULT false,
	"merged_into_id" text,
	"merged_at" timestamp,
	"consolidated_from" text,
	"consolidated_at" timestamp,
	"is_consolidated" boolean DEFAULT false,
	"encrypted_content" text,
	"encryption_nonce" text,
	"is_encrypted" boolean DEFAULT false,
	"compression_level" integer,
	"relevance_score" integer DEFAULT 50,
	"tokens_estimate" integer DEFAULT 0,
	"decay_rate" integer DEFAULT 30,
	"coactivation_score" integer DEFAULT 0,
	"last_decay_at" timestamp DEFAULT now(),
	"has_l0_abstract" boolean DEFAULT false,
	"has_l1_overview" boolean DEFAULT false,
	"last_layer_update" timestamp,
	"media_type" text,
	"media_path" text,
	"media_metadata" text,
	"namespace_id" text,
	"namespace_path" text,
	"employee_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "knowledge_edges" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" text NOT NULL,
	"from_kind" text NOT NULL,
	"to_id" text NOT NULL,
	"to_kind" text NOT NULL,
	"edge_type" text NOT NULL,
	"weight" real DEFAULT 1,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"valid_from" timestamp,
	"valid_to" timestamp,
	"recorded_at" timestamp,
	"recorded_to" timestamp
);

CREATE INDEX "knowledge_project_idx" ON "knowledge" USING btree ("project_id");
CREATE INDEX "knowledge_kind_idx" ON "knowledge" USING btree ("knowledge_kind");
CREATE INDEX "knowledge_type_idx" ON "knowledge" USING btree ("knowledge_type");
CREATE INDEX "knowledge_status_idx" ON "knowledge" USING btree ("status");
CREATE INDEX "knowledge_session_idx" ON "knowledge" USING btree ("session_id");
CREATE INDEX "knowledge_user_idx" ON "knowledge" USING btree ("user_id");
CREATE INDEX "knowledge_agent_idx" ON "knowledge" USING btree ("agent_id");
CREATE INDEX "knowledge_confidence_idx" ON "knowledge" USING btree ("confidence");
CREATE INDEX "knowledge_active_idx" ON "knowledge" USING btree ("is_active");
CREATE INDEX "knowledge_created_idx" ON "knowledge" USING btree ("created_at");
CREATE INDEX "knowledge_sector_idx" ON "knowledge" USING btree ("sector");
CREATE INDEX "knowledge_tier_idx" ON "knowledge" USING btree ("tier");
CREATE INDEX "knowledge_project_kind_idx" ON "knowledge" USING btree ("project_id","knowledge_kind");
CREATE INDEX "knowledge_project_status_idx" ON "knowledge" USING btree ("project_id","status");
CREATE INDEX "knowledge_normalized_key_idx" ON "knowledge" USING btree ("normalized_key");
CREATE INDEX "knowledge_edges_from_idx" ON "knowledge_edges" USING btree ("from_id","from_kind");
CREATE INDEX "knowledge_edges_to_idx" ON "knowledge_edges" USING btree ("to_id","to_kind");
CREATE INDEX "knowledge_edges_type_idx" ON "knowledge_edges" USING btree ("edge_type");
CREATE INDEX "knowledge_edges_valid_time_idx" ON "knowledge_edges" USING btree ("valid_from","valid_to","recorded_at","recorded_to");
CREATE UNIQUE INDEX "knowledge_edges_unique" ON "knowledge_edges" USING btree ("from_id","from_kind","to_id","to_kind","edge_type","valid_from","recorded_at");

-- The 0000 PostgreSQL schema predates the unified knowledge runtime. Keep the
-- source tables as the durable upgrade record and import their current rows.
-- The runtime's shared schema uses text IDs; legacy project/user tables use
-- UUID IDs, so these new canonical tables intentionally omit incompatible FKs.
INSERT INTO knowledge (
  id, project_id, user_id, agent_id, session_id,
  knowledge_kind, knowledge_type, content, summary,
  embedding_json, embedding, embedding_model, embedding_dim,
  confidence, confidence_level, importance_score, importance_decay_rate,
  last_importance_recalc, normalized_key, reason, evidence_summary, evidence,
  last_confirmed_at, source_count, title, description, steps, success_criteria,
  failure_indicators, usage_count, success_count, failure_count, last_used_at,
  last_success_at, last_failure_at, status, is_active, sector, tier, version,
  superseded_by, contradicts_id, informed_by_id, tags, metadata, place_id,
  primary_place, is_private, is_protected, is_pinned, is_immutable, write_scope,
  read_scope, scope, visibility_scope, actor_user, actor_agent, agent_role,
  triggered_by, capture_reason, valid_from, valid_to, recorded_at, access_count,
  last_accessed_at, is_merged, merged_into_id, merged_at, consolidated_from,
  consolidated_at, is_consolidated, encrypted_content, encryption_nonce,
  is_encrypted, compression_level, relevance_score, tokens_estimate, decay_rate,
  coactivation_score, last_decay_at, has_l0_abstract, has_l1_overview,
  last_layer_update, media_type, media_path, media_metadata, namespace_id,
  namespace_path, employee_id, created_at, updated_at
)
SELECT
  p.payload->>'id', p.payload->>'project_id', p.payload->>'user_id',
  p.payload->>'agent_id', NULL, 'memory', COALESCE(p.payload->>'type', 'note'),
  COALESCE(p.payload->>'content', ''), p.payload->>'summary',
  p.payload->>'embedding_json', p.payload->>'embedding',
  p.payload->>'embedding_model', NULLIF(p.payload->>'embedding_dim', '')::integer,
  CASE WHEN NULLIF(p.payload->>'confidence', '') IS NULL THEN 0.5
       WHEN ABS((p.payload->>'confidence')::numeric) > 1 THEN (p.payload->>'confidence')::numeric / 100.0
       ELSE (p.payload->>'confidence')::numeric END,
  COALESCE(p.payload->>'confidence_level', 'certain'),
  CASE WHEN NULLIF(p.payload->>'importance_score', '') IS NULL THEN 0.5
       WHEN ABS((p.payload->>'importance_score')::numeric) > 1 THEN (p.payload->>'importance_score')::numeric / 100.0
       ELSE (p.payload->>'importance_score')::numeric END,
  NULLIF(p.payload->>'importance_decay_rate', '')::real,
  NULLIF(p.payload->>'last_importance_recalc', '')::timestamp,
  NULLIF(p.payload->>'normalized_key', ''), NULLIF(p.payload->>'reason', ''),
  NULLIF(p.payload->>'evidence_summary', ''), p.payload->'evidence',
  NULLIF(p.payload->>'last_confirmed_at', '')::timestamp,
  NULLIF(p.payload->>'source_count', '')::integer, NULLIF(p.payload->>'title', ''),
  NULLIF(p.payload->>'description', ''), NULLIF(p.payload->>'steps', ''),
  NULLIF(p.payload->>'success_criteria', ''), NULLIF(p.payload->>'failure_indicators', ''),
  COALESCE(NULLIF(p.payload->>'usage_count', '')::integer, 0),
  COALESCE(NULLIF(p.payload->>'success_count', '')::integer, 0),
  COALESCE(NULLIF(p.payload->>'failure_count', '')::integer, 0),
  NULLIF(p.payload->>'last_used_at', '')::timestamp,
  NULLIF(p.payload->>'last_success_at', '')::timestamp,
  NULLIF(p.payload->>'last_failure_at', '')::timestamp,
  COALESCE(p.payload->>'status', 'active'),
  COALESCE(NULLIF(p.payload->>'is_active', '')::boolean, true),
  COALESCE(p.payload->>'sector', 'general'),
  COALESCE(p.payload->>'tier', 'episodic'),
  COALESCE(NULLIF(p.payload->>'version', '')::integer, 1),
  p.payload->>'superseded_by', p.payload->>'contradicts_id', p.payload->>'informed_by_id',
  CASE WHEN p.payload ? 'tags' THEN (p.payload->'tags')::text END,
  CASE
    WHEN jsonb_typeof(p.payload->'metadata') = 'object'
      THEN p.payload->'metadata' || CASE WHEN p.payload->'source' IS NULL OR p.payload->'source' = 'null'::jsonb
        THEN '{}'::jsonb ELSE jsonb_build_object('legacySource', p.payload->'source') END
    WHEN p.payload->'metadata' IS NOT NULL
      THEN jsonb_build_object('legacyMetadata', p.payload->'metadata', 'legacySource', p.payload->'source')
    WHEN p.payload->'source' IS NOT NULL AND p.payload->'source' <> 'null'::jsonb
      THEN jsonb_build_object('legacySource', p.payload->'source')
    ELSE NULL
  END,
  p.payload->>'place_id', NULL,
  COALESCE(NULLIF(p.payload->>'is_private', '')::boolean, false),
  COALESCE(NULLIF(p.payload->>'is_protected', '')::boolean, false),
  COALESCE(NULLIF(p.payload->>'is_pinned', '')::boolean, false),
  COALESCE(NULLIF(p.payload->>'is_immutable', '')::boolean, false),
  CASE WHEN p.payload ? 'write_scope' THEN (p.payload->'write_scope')::text END,
  CASE WHEN p.payload ? 'read_scope' THEN (p.payload->'read_scope')::text END,
  COALESCE(p.payload->>'scope', 'company'),
  COALESCE(p.payload->>'visibility_scope', 'private'),
  p.payload->>'actor_user', p.payload->>'actor_agent', p.payload->>'agent_role',
  p.payload->>'triggered_by', p.payload->>'capture_reason',
  NULLIF(p.payload->>'valid_from', '')::timestamp,
  NULLIF(p.payload->>'valid_to', '')::timestamp,
  COALESCE(NULLIF(p.payload->>'recorded_at', '')::timestamp,
           NULLIF(p.payload->>'created_at', '')::timestamp, now()),
  COALESCE(NULLIF(p.payload->>'access_count', '')::integer, 0),
  NULLIF(p.payload->>'last_accessed_at', '')::timestamp,
  COALESCE(NULLIF(p.payload->>'is_merged', '')::boolean, false),
  p.payload->>'merged_into_id', NULLIF(p.payload->>'merged_at', '')::timestamp,
  p.payload->>'consolidated_from', NULLIF(p.payload->>'consolidated_at', '')::timestamp,
  COALESCE(NULLIF(p.payload->>'is_consolidated', '')::boolean, false),
  p.payload->>'encrypted_content', p.payload->>'encryption_nonce',
  COALESCE(NULLIF(p.payload->>'is_encrypted', '')::boolean, false),
  NULLIF(p.payload->>'compression_level', '')::integer,
  COALESCE(NULLIF(p.payload->>'relevance_score', '')::integer, 50),
  COALESCE(NULLIF(p.payload->>'tokens_estimate', '')::integer, 0),
  COALESCE(NULLIF(p.payload->>'decay_rate', '')::integer, 30),
  COALESCE(NULLIF(p.payload->>'coactivation_score', '')::integer, 0),
  COALESCE(NULLIF(p.payload->>'last_decay_at', '')::timestamp,
           NULLIF(p.payload->>'created_at', '')::timestamp, now()),
  COALESCE(NULLIF(p.payload->>'has_l0_abstract', '')::boolean, false),
  COALESCE(NULLIF(p.payload->>'has_l1_overview', '')::boolean, false),
  NULLIF(p.payload->>'last_layer_update', '')::timestamp,
  p.payload->>'media_type', p.payload->>'media_path', p.payload->>'media_metadata',
  p.payload->>'namespace_id', p.payload->>'namespace_path', p.payload->>'employee_id',
  COALESCE(NULLIF(p.payload->>'created_at', '')::timestamp, now()),
  COALESCE(NULLIF(p.payload->>'updated_at', '')::timestamp, now())
FROM memories AS m
CROSS JOIN LATERAL (SELECT to_jsonb(m) AS payload) AS p
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  source_count bigint;
  reconciled_count bigint;
BEGIN
  SELECT COUNT(*) INTO source_count FROM memories;
  SELECT COUNT(*) INTO reconciled_count
  FROM memories AS m
  CROSS JOIN LATERAL (SELECT to_jsonb(m) AS payload) AS p
  JOIN knowledge AS k ON k.id = p.payload->>'id'
  WHERE k.knowledge_kind = 'memory'
    AND k.knowledge_type = COALESCE(p.payload->>'type', 'note')
    AND k.content = COALESCE(p.payload->>'content', '')
    AND k.project_id IS NOT DISTINCT FROM p.payload->>'project_id'
    AND k.user_id IS NOT DISTINCT FROM p.payload->>'user_id';
  IF source_count <> reconciled_count THEN
    RAISE EXCEPTION 'canonical memory reconciliation failed: % source rows, % matched', source_count, reconciled_count;
  END IF;
END $$;

INSERT INTO knowledge_edges (
  id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata,
  created_at, valid_from, recorded_at
)
SELECT
  'legacy:memory_associations:' || a.id::text,
  a.from_memory_id::text, 'knowledge', a.to_memory_id::text, 'knowledge',
  a.association_type, COALESCE(a.weight, 1)::real,
  jsonb_build_object(
    'legacyMigration', jsonb_build_object('sourceTable', 'memory_associations', 'sourceId', a.id::text, 'trust', 'unverified_legacy'),
    'legacyPayload', to_jsonb(a)
  ),
  a.created_at, a.created_at, a.created_at
FROM memory_associations AS a
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE source_count bigint; reconciled_count bigint;
BEGIN
  SELECT COUNT(*) INTO source_count FROM memory_associations;
  SELECT COUNT(*) INTO reconciled_count
  FROM memory_associations AS a JOIN knowledge_edges AS e
    ON e.id = 'legacy:memory_associations:' || a.id::text
  WHERE e.from_id = a.from_memory_id::text AND e.from_kind = 'knowledge'
    AND e.to_id = a.to_memory_id::text AND e.to_kind = 'knowledge'
    AND e.edge_type = a.association_type AND e.weight = COALESCE(a.weight, 1)::real
    AND e.metadata->'legacyPayload' = to_jsonb(a);
  IF source_count <> reconciled_count THEN
    RAISE EXCEPTION 'memory association reconciliation failed: % source rows, % matched', source_count, reconciled_count;
  END IF;
END $$;

INSERT INTO knowledge_edges (
  id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata,
  created_at, valid_from, recorded_at
)
SELECT
  'legacy:entity_relations:' || r.id::text,
  r.from_entity_id::text, 'entity', r.to_entity_id::text, 'entity',
  r.type, COALESCE(r.weight, 1)::real,
  jsonb_build_object(
    'legacyMigration', jsonb_build_object('sourceTable', 'entity_relations', 'sourceId', r.id::text, 'trust', 'unverified_legacy'),
    'legacyPayload', to_jsonb(r)
  ),
  r.created_at, r.created_at, r.created_at
FROM entity_relations AS r
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE source_count bigint; reconciled_count bigint;
BEGIN
  SELECT COUNT(*) INTO source_count FROM entity_relations;
  SELECT COUNT(*) INTO reconciled_count
  FROM entity_relations AS r JOIN knowledge_edges AS e
    ON e.id = 'legacy:entity_relations:' || r.id::text
  WHERE e.from_id = r.from_entity_id::text AND e.from_kind = 'entity'
    AND e.to_id = r.to_entity_id::text AND e.to_kind = 'entity'
    AND e.edge_type = r.type AND e.weight = COALESCE(r.weight, 1)::real
    AND e.metadata->'legacyPayload' = to_jsonb(r);
  IF source_count <> reconciled_count THEN
    RAISE EXCEPTION 'entity relation reconciliation failed: % source rows, % matched', source_count, reconciled_count;
  END IF;
END $$;
