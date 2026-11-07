/**
 * Unified Knowledge Store — Re-export barrel.
 *
 * This module was split into focused sub-modules:
 *   - helpers.ts          — serialization & row mappers (internal)
 *   - knowledge-crud.ts   — table creation, CRUD, search
 *   - knowledge-edges.ts  — edge CRUD & graph traversal
 *   - knowledge-beliefs.ts — belief adapter functions
 *
 * All public symbols are re-exported here so existing imports from
 * '../knowledge/store.js' continue to work without changes.
 */

// ─── Table Creation & Knowledge CRUD ─────────────────────────────────────────
export {
  ensureKnowledgeTables,
  createKnowledge,
  getKnowledgeById,
  updateKnowledge,
  deleteKnowledge,
  searchKnowledge,
  listKnowledgeByKind,
} from './knowledge-crud.js';

// ─── Knowledge Edges ─────────────────────────────────────────────────────────
export {
  createKnowledgeEdge,
  getEdgesFrom,
  getEdgesTo,
  getEdgesForNode,
  deleteKnowledgeEdge,
  deleteEdgesForNode,
  getConnectedEntities,
  getConnectedPlaces,
} from './knowledge-edges.js';

// ─── Belief Adapters ────────────────────────────────────────────────────────
export {
  upsertBeliefsForMemory,
  getBeliefsForMemory,
  getActiveConstraints,
  getActiveDecisions,
  getRecentFailures,
  searchBeliefs,
  getAllBeliefs,
  getRelevantBeliefs,
} from './knowledge-beliefs.js';

// ─── Graph Views ─────────────────────────────────────────────────────────────
export {
  createGraphView,
  getSemanticView,
  getTemporalView,
  getCausalView,
  getEntityView,
} from './graph-views.js';
export { queryGraphView } from './graph-view-engine.js';

// ─── Audit Trail & Provenance ────────────────────────────────────────────────
export {
  ensureAuditTable,
  logAuditEntry,
  getAuditTrail,
  getProvenanceChain,
} from './audit.js';
export type {
  AuditAction,
  AuditEntry,
  LogAuditInput,
  AuditTrailOptions,
  ProvenanceNode,
} from './audit.js';
