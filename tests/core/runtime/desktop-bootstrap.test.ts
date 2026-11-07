import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), `squish-desktop-bootstrap-${Date.now()}-`));
const databasePath = join(dataDir, 'squish.db');
let priorDataDir: string | undefined;
let priorDatabaseUrl: string | undefined;
let bootstrapDesktopRuntime: typeof import('../../../core/runtime/desktop-bootstrap.js').bootstrapDesktopRuntime;
let operateDesktopWorkspace: typeof import('../../../core/runtime/desktop-bootstrap.js').operateDesktopWorkspace;
let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;

beforeAll(async () => {
  priorDataDir = process.env.SQUISH_DATA_DIR;
  priorDatabaseUrl = process.env.SQUISH_DATABASE_URL;
  process.env.SQUISH_DATA_DIR = dataDir;
  delete process.env.SQUISH_DATABASE_URL;
  ({ bootstrapDesktopRuntime } = await import('../../../core/runtime/desktop-bootstrap.js'));
  ({ operateDesktopWorkspace } = await import('../../../core/runtime/desktop-bootstrap.js'));
  ({ closeAllDbs } = await import('../../../db/index.js'));
});

afterAll(async () => {
  await closeAllDbs?.();
  if (priorDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = priorDataDir;
  if (priorDatabaseUrl === undefined) delete process.env.SQUISH_DATABASE_URL;
  else process.env.SQUISH_DATABASE_URL = priorDatabaseUrl;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may briefly retain SQLite sidecar handles. */ }
});

describe('desktop bootstrap contract v1', () => {
  test('rejects unknown contract versions without creating the database', async () => {
    const { DesktopBootstrapError } = await import('../../../core/runtime/desktop-bootstrap.js');

    await expect(bootstrapDesktopRuntime({ contractVersion: 99 })).rejects.toBeInstanceOf(DesktopBootstrapError);
    expect(existsSync(databasePath)).toBe(false);
  });

  test('rejects team mode without creating a local database', async () => {
    process.env.SQUISH_DATABASE_URL = 'postgres://example.invalid/squish';
    try {
      await expect(bootstrapDesktopRuntime({ contractVersion: 1 })).rejects.toMatchObject({
        code: 'local_sqlite_required',
      });
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      delete process.env.SQUISH_DATABASE_URL;
    }
  });

  test('creates and verifies the core-owned schema and is safe to repeat', async () => {
    const first = await bootstrapDesktopRuntime({ contractVersion: 1 });
    expect(first).toEqual({
      ok: true,
      contractVersion: 1,
      backend: 'sqlite',
      schemaReady: true,
      dataDir,
      databasePath,
    });
    expect(existsSync(databasePath)).toBe(true);

    const second = await bootstrapDesktopRuntime({ contractVersion: 1 });
    expect(second).toEqual(first);

    const output: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    try {
      const { createProgram } = await import('../../../cli/program.ts');
      await createProgram().parseAsync(['node', 'squish', 'bootstrap', '--contract-version', '1']);
    } finally {
      process.stdout.write = write;
    }
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toEqual(first);
  });

  test('returns graph labels, tags, and project display names without leaking project paths', async () => {
    await bootstrapDesktopRuntime({ contractVersion: 1 });
    const { db, schema } = await (await import('../../../core/lib/db-client.js')).getDbClient();
    const projectId = 'graph-project-fixture';
    const otherProjectId = 'graph-other-project-fixture';
    const memoryId = 'graph-memory-fixture';
    const entityId = 'graph-entity-fixture';
    const supportedEntityId = 'graph-supported-entity-fixture';
    const otherProjectEntityId = 'graph-other-project-entity-fixture';
    const futureEntityId = 'graph-future-entity-fixture';
    const notYetValidEntityId = 'graph-not-yet-valid-entity-fixture';
    const expiredEntityId = 'graph-expired-entity-fixture';
    const supersededEntityId = 'graph-superseded-entity-fixture';
    const expiredKnowledgeEntityId = 'graph-expired-knowledge-entity-fixture';
    const knowledgeId = 'graph-knowledge-projection-fixture';
    await db.insert(schema.projects).values([
      { id: projectId, name: 'C:\\private\\workspace-root', path: 'C:\\private\\workspace-root' },
      { id: otherProjectId, name: 'C:\\private\\other-workspace', path: 'C:\\private\\other-workspace' },
    ]);
    await db.insert(schema.memories).values({
      id: memoryId,
      projectId,
      type: 'decision',
      content: 'Use a local runtime for durable project context.',
      summary: 'Local runtime preserves durable project context',
      tags: JSON.stringify(['architecture', 'runtime']) as unknown as string[],
      metadata: JSON.stringify({ entities: ['Squish Runtime'] }),
    });
    await db.insert(schema.entities).values([
      { id: entityId, projectId, name: 'Squish Runtime', type: 'product', mentionCount: 1 },
      { id: supportedEntityId, projectId, name: 'Local Context', type: 'concept', mentionCount: 1 },
      { id: otherProjectEntityId, projectId: otherProjectId, name: 'Foreign Context', type: 'concept', mentionCount: 1 },
      { id: futureEntityId, projectId, name: 'Future Context', type: 'concept', mentionCount: 1 },
      { id: notYetValidEntityId, projectId, name: 'Not Yet Valid Context', type: 'concept', mentionCount: 1 },
      { id: expiredEntityId, projectId, name: 'Expired Context', type: 'concept', mentionCount: 1 },
      { id: supersededEntityId, projectId, name: 'Superseded Context', type: 'concept', mentionCount: 1 },
      { id: expiredKnowledgeEntityId, projectId, name: 'Expired Knowledge Context', type: 'concept', mentionCount: 1 },
    ]);
    await db.insert(schema.knowledge).values({
      id: knowledgeId,
      projectId,
      knowledgeKind: 'memory',
      knowledgeType: 'decision',
      content: 'Projection for graph test',
      metadata: JSON.stringify({ sourceMemoryId: memoryId }),
    });
    await db.insert(schema.knowledgeEdges).values({
      id: 'graph-memory-entity-edge-fixture',
      fromId: knowledgeId,
      fromKind: 'knowledge',
      toId: entityId,
      toKind: 'entity',
      edgeType: 'about',
    });
    await db.insert(schema.knowledgeEdges).values([
      {
        id: 'graph-supported-entity-relation-fixture',
        fromId: entityId,
        fromKind: 'entity',
        toId: supportedEntityId,
        toKind: 'entity',
        edgeType: 'mentioned_together',
        metadata: JSON.stringify({ sourceMemoryIds: [memoryId, memoryId] }) as unknown as Record<string, unknown>,
      },
      {
        id: 'graph-cross-project-entity-relation-fixture',
        fromId: entityId,
        fromKind: 'entity',
        toId: otherProjectEntityId,
        toKind: 'entity',
        edgeType: 'mentioned_together',
        metadata: JSON.stringify({ sourceMemoryIds: [memoryId] }) as unknown as Record<string, unknown>,
      },
      {
        id: 'graph-future-recorded-entity-relation-fixture',
        fromId: entityId,
        fromKind: 'entity',
        toId: futureEntityId,
        toKind: 'entity',
        edgeType: 'mentioned_together',
        recordedAt: new Date(Date.now() + 60_000),
        metadata: JSON.stringify({ sourceMemoryIds: [memoryId] }) as unknown as Record<string, unknown>,
      },
      {
        id: 'graph-future-valid-entity-relation-fixture',
        fromId: entityId,
        fromKind: 'entity',
        toId: notYetValidEntityId,
        toKind: 'entity',
        edgeType: 'mentioned_together',
        validFrom: new Date(Date.now() + 60_000),
        metadata: JSON.stringify({ sourceMemoryIds: [memoryId] }) as unknown as Record<string, unknown>,
      },
      {
        id: 'graph-expired-valid-entity-relation-fixture',
        fromId: entityId,
        fromKind: 'entity',
        toId: expiredEntityId,
        toKind: 'entity',
        edgeType: 'mentioned_together',
        validFrom: new Date(Date.now() - 120_000),
        validTo: new Date(Date.now() - 60_000),
        metadata: JSON.stringify({ sourceMemoryIds: [memoryId] }) as unknown as Record<string, unknown>,
      },
      {
        id: 'graph-superseded-entity-relation-fixture',
        fromId: entityId,
        fromKind: 'entity',
        toId: supersededEntityId,
        toKind: 'entity',
        edgeType: 'mentioned_together',
        recordedAt: new Date(Date.now() - 120_000),
        recordedTo: new Date(Date.now() - 60_000),
        metadata: JSON.stringify({ sourceMemoryIds: [memoryId] }) as unknown as Record<string, unknown>,
      },
      {
        id: 'graph-expired-knowledge-entity-edge-fixture',
        fromId: knowledgeId,
        fromKind: 'knowledge',
        toId: expiredKnowledgeEntityId,
        toKind: 'entity',
        edgeType: 'about',
        validFrom: new Date(Date.now() - 120_000),
        validTo: new Date(Date.now() - 60_000),
      },
    ]);
    await closeAllDbs();

    const result = await operateDesktopWorkspace({ contractVersion: 1, action: 'graph', limit: 10 });
    expect('nodes' in result).toBe(true);
    if (!('nodes' in result)) return;
    expect(result.nodes.find((node) => node.id === memoryId)).toMatchObject({
      label: 'Local runtime preserves durable project context',
      tags: ['architecture', 'runtime'],
      projectName: 'workspace-root',
    });
    expect(result.nodes.find((node) => node.id === entityId)).toMatchObject({ label: 'Squish Runtime', type: 'entity', entityType: 'product' });
    expect(result.nodes.find((node) => node.id === supportedEntityId)).toMatchObject({ label: 'Local Context', type: 'entity' });
    expect(result.nodes.some((node) => node.id === otherProjectEntityId)).toBe(false);
    expect(result.nodes.some((node) => node.id === futureEntityId)).toBe(false);
    expect(result.nodes.some((node) => [notYetValidEntityId, expiredEntityId, supersededEntityId, expiredKnowledgeEntityId].includes(node.id))).toBe(false);
    expect(result.links).toContainEqual({ source: memoryId, target: entityId, label: 'mentions', weight: 1.5 });
    expect(result.links).toContainEqual({ source: memoryId, target: entityId, label: 'about', weight: 1 });
    expect(result.links).toContainEqual({ source: memoryId, target: supportedEntityId, label: 'mentions', weight: 1.5 });
    expect(result.links.filter((link) => link.source === memoryId && link.target === supportedEntityId && link.label === 'mentions')).toHaveLength(1);
    expect(result.links.some((link) => link.source === memoryId && link.target === otherProjectEntityId)).toBe(false);
    expect(result.links.some((link) => link.source === entityId && link.target === futureEntityId)).toBe(false);
    expect(result.links.some((link) => [notYetValidEntityId, expiredEntityId, supersededEntityId, expiredKnowledgeEntityId].includes(link.target))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private\\\\workspace-root');

    const client = await (await import('../../../core/lib/db-client.js')).getDbClient();
    await client.db.delete(client.schema.projects).where((await import('drizzle-orm')).eq(client.schema.projects.id, projectId));
    await closeAllDbs();
  });
});
