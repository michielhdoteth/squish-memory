# Squish Memory - Fixes Required

**Audit Date:** 2026-09-18
**Auditors:** SRE Engineer, Code Simplifier, Security Auditor

---

## Critical Fixes (Do First)

### 1. Timing Attack on API Key Comparison
**Severity:** HIGH | **Category:** Security
**File:** `packages/mcp/src/index.ts:1157`

**Problem:** API key comparison uses `!==` which short-circuits on first mismatch, enabling timing attacks to guess the key character by character.

**Fix:** Use `crypto.timingSafeEqual`:
```typescript
import { timingSafeEqual } from 'crypto';

function checkMcpAuth(req, res): boolean {
  const provided = req.headers['x-api-key'] as string || req.headers['authorization']?.replace('Bearer ', '') || '';
  if (provided.length !== MCP_API_KEY.length) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(MCP_API_KEY);
  if (!timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
```

---

### 2. Wildcard CORS on Authenticated Endpoint
**Severity:** HIGH | **Category:** Security
**File:** `packages/mcp/src/index.ts:1111`

**Problem:** `Access-Control-Allow-Origin: *` on `/mcp` endpoint allows any website to make authenticated requests if user has the API key.

**Fix:** Restrict to specific origins:
```typescript
const ALLOWED_ORIGINS = (process.env.SQUISH_CORS_ORIGINS || '').split(',').filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0) {
    res.header('Access-Control-Allow-Origin', 'http://localhost:' + port);
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  // ... rest of CORS headers
});
```

---

### 3. No Rate Limiting on HTTP Transport
**Severity:** HIGH | **Category:** Security
**File:** `packages/mcp/src/index.ts:1076-1295`

**Problem:** `express-rate-limit` is in dependencies but never used. Server can be DoS'd with rapid requests.

**Fix:** Add rate limiting:
```typescript
import rateLimit from 'express-rate-limit';

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

app.use('/mcp', mcpLimiter);
```

---

### 4. SQL Injection via String Interpolation
**Severity:** HIGH | **Category:** Security
**Files:** `db/schema-health.ts:165`, `db/merge-client-dbs.ts:148,283,297,318,341,482`

**Problem:** Table names interpolated directly into PRAGMA queries. While table names come from schema (not user input), `merge-client-dbs.ts` processes external `.db` files with potentially malicious table names.

**Fix:** Centralize identifier quoting:
```typescript
function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
// Usage:
raw.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all()
```

---

### 5. sql.js Fallback Rewrites Entire DB on Every Write
**Severity:** CRITICAL | **Category:** SRE
**File:** `db/adapter.ts:16-48`
**Status:** FIXED

**Problem:** When sql.js is used as fallback, `fs.writeFileSync` serializes entire in-memory DB on every write. Concurrent processes silently overwrite each other's changes.

**Fix:** Default `SQUISH_ALLOW_SQLJS_FALLBACK` to `false` (blocked). On startup, if only sql.js available, refuse to start with remediation message. Requires explicit opt-in via `SQUISH_ALLOW_SQLJS_FALLBACK=true`.

---

## High Priority Fixes

### 6. File Path Traversal in Multimodal Ingestion
**Severity:** MEDIUM | **Category:** Security
**Files:** `core/multimodal/ingest-pipeline.ts:62`, `packages/mcp/src/multimodal-utils.ts:48`

**Problem:** `filePath` parameter passed directly to `readFile()` without validation. Attacker can read `/etc/passwd` or SSH keys.

**Fix:** Validate path is within allowed directory:
```typescript
import { resolve, relative } from 'path';

function isPathAllowed(filePath: string, allowedDirs: string[]): boolean {
  const resolved = resolve(filePath);
  return allowedDirs.some(dir => resolved.startsWith(resolve(dir)));
}

const allowedDirs = [config.dataDir, config.multimodalInboxDir, process.cwd()];
if (!isPathAllowed(filePath, allowedDirs)) {
  throw new Error(`Path not in allowed directory: ${filePath}`);
}
```

---

### 7. Unbounded Session Map - DoS Vector
**Severity:** MEDIUM | **Category:** Security
**File:** `packages/mcp/src/index.ts:1090`

**Problem:** `transports` Map has no max size. Attacker can create unlimited sessions via repeated `initialize` requests.

**Fix:** Add session cap:
```typescript
const MAX_SESSIONS = 100;

if (transports.size >= MAX_SESSIONS) {
  res.status(503).json({ error: 'Server at session capacity' });
  return;
}
```

---

### 8. No Backup Mechanism for SQLite
**Severity:** CRITICAL | **Category:** SRE

**Problem:** SQLite WAL prevents corruption on crash but no protection against disk failure, accidental deletion, or schema migration bugs.

**Fix:** Add `squish backup` CLI command using SQLite's `.backup` API or file copy. Document manual backup instructions. Add configurable backup path in `config.ts`.

---

### 9. Telemetry Event Cache Grows Unbounded
**Severity:** MEDIUM | **Category:** SRE
**File:** `core/memory/telemetry.ts:45-76`

**Problem:** `retrievalEvents` array grows unbounded between flushes. Echo/fizzle counters can become inconsistent.

**Fix:** Add periodic flush timer (every 60s) independent of 1000-entry cap. Consider ring buffer. Make counters atomic or flush together.

---

### 10. Health Check Leaks Server Internals
**Severity:** MEDIUM | **Category:** Security
**File:** `packages/mcp/src/index.ts:1128-1147`

**Problem:** `/health` returns `detail`, `remediation`, `missingTables` to unauthenticated callers.

**Fix:** Return minimal status without internal details:
```typescript
app.get("/health", (req, res) => {
  void probeSchemaHealth().then((probe) => {
    res.json({
      status: probe.status === "ok" ? "ok" : "degraded",
      version: SERVER_VERSION,
    });
  });
});
```

---

### 11. Schema Mismatch Between initDB() and Drizzle
**Severity:** HIGH | **Category:** SRE
**Files:** `MAP.md`, database initialization

**Problem:** `metadata` JSONB column referenced in queries but missing from `projects` table. `initDB()` creates different schema than Drizzle ORM expects.

**Fix:** Consolidate schema definitions. Use Drizzle schema as single source of truth. Remove duplicate `initDB()` or migrate it to use Drizzle. Run migration generation to verify alignment.

---

### 12. No Graceful Shutdown for Cron Scheduler
**Severity:** MEDIUM | **Category:** SRE
**File:** `core/scheduler/cron-scheduler.ts`

**Problem:** In-flight jobs interrupted on SIGTERM. No `stop()` or `gracefulShutdown()`.

**Fix:** Add `shutdown()` method: (1) stop new jobs, (2) wait for in-flight with timeout, (3) flush telemetry, (4) close DB connection.

---

## Medium Priority Fixes

### 13. Duplicate Schema Caching
**Severity:** LOW | **Category:** Code Simplification
**Files:** `db/schema.ts`, `core/lib/db-client.ts`

**Problem:** Two independent schema caches exist with different `clearCache()` functions.

**Fix:** Remove duplicate cache in `db-client.ts`. Use `getSchema()` from `db/schema.ts` directly.

---

### 14. Schema Health God File (899 lines)
**Severity:** MEDIUM | **Category:** Code Simplification
**File:** `db/schema-health.ts`

**Problem:** Mixed concerns: schema probing, repair, table creation, FTS repair, health checks.

**Fix:** Split into 3 files:
- `schema-probe.ts` - health checks
- `schema-repair.ts` - repair logic
- `schema-ddl.ts` - table creation DDL

---

### 15. hybrid-search.ts 570-Line Function
**Severity:** MEDIUM | **Category:** Code Simplification
**File:** `core/memory/hybrid-search.ts`

**Problem:** 25-stage pipeline in single function. Duplicated query expansion functions.

**Fix:** Break into pipeline array of pure functions. Remove `expandQueryForMultiSession()` and `expandQueryForTemporal()` - use `expandQuery()` with config.

---

### 16. Compiled .d.ts Files Not Gitignored
**Severity:** LOW | **Category:** Code Simplification

**Problem:** `.d.ts` files are build artifacts but not in `.gitignore`.

**Fix:** Add `*.d.ts` to `.gitignore`. Remove tracked `.d.ts` files.

---

### 17. Dead Code
**Severity:** LOW | **Category:** Code Simplification

**Problem:** Multiple dead functions identified:
- `isLocalMode()` - always returns `true`
- `describeBackend()` - always returns `'local:sqlite'`
- `getRawClient()` - only used within `schema-health.ts`
- `expandQueryForMultiSession()` / `expandQueryForTemporal()` - overlap with `expandQuery()`

**Fix:** Remove or inline these functions.

---

### 18. Database Client Initialization Boilerplate
**Severity:** MEDIUM | **Category:** Code Simplification

**Problem:** 100+ call sites repeat `getDb()` + `getSchema()` pattern instead of using `getDbClient()`.

**Fix:** Migrate high-call-count files to use `getDbClient()`. Add ESLint rule to enforce pattern.

---

### 19. Sensitive Data in Debug Logs
**Severity:** MEDIUM | **Category:** Security
**Files:** `core/security/encrypt.ts`, `core/memory/memory-write.ts`

**Problem:** Debug logs may contain memory content, entity names, or encryption details.

**Fix:** Never log memory content, even at debug level:
```typescript
logger.debug(`[Memory] Stored memory ${id}`, { tags, type, contentLength: content.length });
```

---

### 20. Missing Input Validation on CLI
**Severity:** MEDIUM | **Category:** Security
**File:** `packages/cli/src/commands/run.ts:46`

**Problem:** `run` command spawns child processes with runtime-resolved commands without validation.

**Fix:** Validate resolved command is in allowlist of known runtime binaries (node, bun, python).

---

### 21. No HTTPS Enforcement
**Severity:** LOW | **Category:** Security
**File:** `packages/mcp/src/index.ts:1288`

**Problem:** HTTP server listens on plain HTTP. API keys transmitted in plaintext.

**Fix:** Document HTTP mode is for local use only. Recommend reverse proxy with TLS for remote access.

---

### 22. .env Loaded Globally
**Severity:** LOW | **Category:** Security
**File:** `packages/mcp/src/index.ts:4`

**Problem:** `import 'dotenv/config'` loads from CWD, may load wrong `.env` or leak to child processes.

**Fix:** Use explicit path:
```typescript
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });
```

---

### 23. Session ID Not Validated
**Severity:** LOW | **Category:** Security
**File:** `packages/mcp/src/index.ts:1168`

**Problem:** Session ID used as Map key without format validation.

**Fix:** Validate UUID format:
```typescript
if (sessionId && !/^[0-9a-f-]{36}$/i.test(sessionId)) {
  res.status(400).json({ error: 'Invalid session ID format' });
  return;
}
```

---

## Priority Execution Order

### Phase 1: Security Critical (Week 1)
1. Fix timing attack on API key comparison (#1)
2. Restrict CORS origins (#2)
3. Add rate limiting (#3)
4. Fix SQL injection patterns (#4)
5. Disable sql.js fallback by default (#5)

### Phase 2: Security High (Week 2)
6. Add path validation for file ingestion (#6)
7. Cap session count (#7)
8. Add backup mechanism (#8)
9. Fix telemetry cache bounds (#9)
10. Sanitize health check output (#10)

### Phase 3: Reliability (Week 3)
11. Consolidate schema definitions (#11)
12. Add graceful shutdown (#12)
13. Add structured logging
14. Add health check endpoint

### Phase 4: Code Quality (Week 4)
15. Remove duplicate schema cache (#13)
16. Split schema-health.ts (#14)
17. Refactor hybrid-search pipeline (#15)
18. Add .d.ts to gitignore (#16)
19. Remove dead code (#17)
20. Migrate to getDbClient pattern (#18)

---

## Suggested SLOs

| SLI | Target | Rationale |
|-----|--------|-----------|
| Memory write success rate | 99.9% | Users expect writes to succeed on local disk |
| Memory search latency (p95) | < 500ms | Agent tool calls should be fast |
| CLI command latency (p95) | < 2s | Developer workflow responsiveness |
| MCP server availability | 99.5% | Tolerates brief restarts during upgrades |
| Data durability | 99.99% | Core value prop - memories must survive |
| Backup restore success | 100% | Backup is useless if restore fails |
| Schema migration success | 100% | Broken schema = broken product |
| Secret detection accuracy | 99% | Security-critical path |

---

*Generated by Squish Memory Security & Reliability Audit - 2026-09-18*
