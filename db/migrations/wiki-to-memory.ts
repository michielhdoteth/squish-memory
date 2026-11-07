/**
 * Wiki-to-memory migration (Batch 8).
 *
 * Operator decision: squish stores memories in the database ONLY - no
 * markdown pages / document subsystem. The wiki subsystem (wiki_pages,
 * wiki_links, wiki_page_versions + core/wiki + squish_wiki MCP tool) is
 * deleted; existing page data must not be lost.
 *
 * This one-time migration converts legacy wiki_pages rows into memory rows
 * using the same semantics as the live write path:
 *
 * - type: 'decision' when the page was a decision page, otherwise 'fact'
 *   (both route to the semantic sector via routeSector).
 * - content: "# <title>\n\n<content>" (+ "\n\nSummary: <summary>" when set).
 * - tags: page tags + 'wiki-origin' provenance tag.
 * - metadata: { wikiOrigin: true, wikiSlug, wikiPageType, wikiStatus,
 *   migratedAt } so the origin stays auditable.
 * - metadata.wikiVersions: full edit history from wiki_page_versions
 *   (array of { at, content }), so version history is preserved, not
 *   destroyed.
 * - source: 'wiki-migration'; createdAt/updatedAt preserved.
 *
 * Resolvable [[wikilinks]] become canonical 'relates_to' knowledge edges
 * between the migrated memory projections.
 *
 * Gating:
 * - Marker row '2.2.0-wiki-to-memory' in _schema_versions makes it one-time
 *   and idempotent.
 * - SQUISH_WIKI_MIGRATE_DRY_RUN=true previews counts without writing and
 *   leaves the marker unset so a later apply still runs.
 * - Fresh installs (no wiki_pages table) just record the marker.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { logger } from '../../core/logger.js';

export const WIKI_TO_MEMORY_MARKER = '2.2.0-wiki-to-memory';

export interface WikiMigrationReport {
  ran: boolean;
  dryRun: boolean;
  pagesFound: number;
  pagesMigrated: number;
  versionsMigrated: number;
  linksResolved: number;
  linksUnresolved: number;
}

interface LegacyPageRow {
  id: string;
  project_id: string | null;
  user_id: string | null;
  title: string;
  slug: string;
  content: string | null;
  summary: string | null;
  page_type: string;
  status: string;
  visibility: string;
  tags: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

function tableExists(sqlite: Database, name: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

function markerApplied(sqlite: Database): boolean {
  try {
    const row = sqlite
      .prepare('SELECT version FROM _schema_versions WHERE version = ?')
      .get(WIKI_TO_MEMORY_MARKER);
    return !!row;
  } catch {
    return false;
  }
}

function recordMarker(sqlite: Database): void {
  sqlite
    .prepare('INSERT OR IGNORE INTO _schema_versions (version, description) VALUES (?, ?)')
    .run(WIKI_TO_MEMORY_MARKER, 'Wiki subsystem removed; pages migrated into memories (db-only)');
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Run the one-time wiki -> memory migration.
 * Called from ensureSqliteSchema after regular migrations.
 */
export function runWikiToMemoryMigration(
  sqlite: Database,
  options: { dryRun?: boolean } = {}
): WikiMigrationReport {
  const report: WikiMigrationReport = {
    ran: false,
    dryRun: false,
    pagesFound: 0,
    pagesMigrated: 0,
    versionsMigrated: 0,
    linksResolved: 0,
    linksUnresolved: 0,
  };

  if (markerApplied(sqlite)) return report;

  // Fresh install or already-dropped database: nothing to migrate.
  if (!tableExists(sqlite, 'wiki_pages')) {
    recordMarker(sqlite);
    return report;
  }

  const dryRun =
    options.dryRun === true || process.env.SQUISH_WIKI_MIGRATE_DRY_RUN === 'true';

  const pages = sqlite.prepare('SELECT * FROM wiki_pages').all() as unknown as LegacyPageRow[];
  report.pagesFound = pages.length;

  // Preserve full edit history: wiki_page_versions rows travel with their page
  // as metadata.wikiVersions (never destroyed — see review finding Batch 8).
  const versionsByPage = new Map<string, Array<{ at: string; content: string }>>();
  if (tableExists(sqlite, 'wiki_page_versions')) {
    const versionRows = sqlite
      .prepare('SELECT page_id, content, created_at FROM wiki_page_versions ORDER BY created_at')
      .all() as unknown as Array<{ page_id: string; content: string | null; created_at: string }>;
    for (const v of versionRows) {
      const list = versionsByPage.get(v.page_id) ?? [];
      list.push({ at: v.created_at, content: v.content ?? '' });
      versionsByPage.set(v.page_id, list);
    }
  }

  if (pages.length === 0) {
    // No data to preserve: drop empties and mark done.
    if (!dryRun) {
      dropLegacyTables(sqlite);
      recordMarker(sqlite);
    }
    report.ran = !dryRun;
    report.dryRun = dryRun;
    return report;
  }

  if (dryRun) {
    report.dryRun = true;
    const links = countLinks(sqlite);
    logger.info(
      `[wiki-migration] DRY RUN: ${pages.length} wiki pages would become memory rows ` +
        `(sector routed via sector-router semantics, tagged wiki-origin); ` +
        `${links.resolvable} of ${links.total} wikilinks would become canonical graph edges. ` +
        `Re-run with SQUISH_WIKI_MIGRATE_DRY_RUN unset to apply.`
    );
    return report;
  }

  const insertMemory = sqlite.prepare(`
    INSERT INTO memories (
      id, project_id, user_id, type, content, summary, source, confidence,
      confidence_level, tags, metadata, importance_score, tokens_estimate,
      is_active, status, sector, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const idByPageId = new Map<string, string>();
  const slugKeyByPageId = new Map<string, string>();

  const tx = sqlite.transaction(() => {
    for (const page of pages) {
      const memId = randomUUID();
      idByPageId.set(page.id, memId);
      slugKeyByPageId.set(page.id, `${page.project_id ?? ''}::${page.slug}`);

      const tags = [...parseJsonArray(page.tags), 'wiki-origin'];
      const content =
        `# ${page.title}\n\n${page.content ?? ''}` +
        (page.summary ? `\n\nSummary: ${page.summary}` : '');
      const type = page.page_type === 'decision' ? 'decision' : 'fact';
      // routeSector semantics for a durable fact/decision page -> semantic.
      const sector = 'semantic';
      const meta = {
        wikiOrigin: true,
        wikiSlug: page.slug,
        wikiPageType: page.page_type,
        wikiStatus: page.status,
        ...(page.metadata ? safeParse(page.metadata) : {}),
      };
      const versions = versionsByPage.get(page.id);
      if (versions && versions.length > 0) {
        (meta as Record<string, unknown>).wikiVersions = versions;
        report.versionsMigrated += versions.length;
      }

      insertMemory.run(
        memId,
        page.project_id,
        page.user_id,
        type,
        content,
        page.summary ?? null,
        'wiki-migration',
        80,
        'certain',
        JSON.stringify(tags),
        JSON.stringify(meta),
        50,
        estimateTokens(content),
        1,
        page.status === 'archived' ? 'archived' : 'active',
        sector,
        page.created_at,
        page.updated_at
      );
      report.pagesMigrated++;
    }

    // Resolvable [[wikilink]] targets -> graph associations.
    const linkRows = sqlite
      .prepare(
        `SELECT l.source_page_id, l.target_page_id, l.target_slug
         FROM wiki_links l JOIN wiki_pages sp ON sp.id = l.source_page_id`
      )
      .all() as unknown as Array<{
      source_page_id: string;
      target_page_id: string | null;
      target_slug: string;
    }>;

    const insertEdge = sqlite.prepare(`
      INSERT OR IGNORE INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, valid_from, recorded_at
      ) VALUES (?, ?, 'knowledge', ?, 'knowledge', 'relates_to', 0.9, ?, ?, ?)
    `);

    const projectIdByPage = new Map(pages.map((p) => [p.id, p.project_id]));
    for (const link of linkRows) {
      let targetId: string | null = null;

      if (link.target_page_id && idByPageId.has(link.target_page_id)) {
        targetId = idByPageId.get(link.target_page_id)!;
      } else {
        // Unresolvable target_page_id: try slug resolution within the same project.
        const sourceProject = projectIdByPage.get(link.source_page_id) ?? '';
        for (const p of pages) {
          if (`${p.project_id ?? ''}::${p.slug}` === `${sourceProject}::${link.target_slug}`) {
            targetId = idByPageId.get(p.id) ?? null;
            break;
          }
        }
      }

      const fromMem = idByPageId.get(link.source_page_id);
      if (targetId && fromMem) {
        const now = Date.now();
        insertEdge.run(
          randomUUID(),
          fromMem,
          targetId,
          JSON.stringify({ source: 'wiki-migration', sourceMemoryId: fromMem, targetMemoryId: targetId, coactivation_count: 1 }),
          now,
          now,
        );
        report.linksResolved++;
      } else {
        report.linksUnresolved++;
      }
    }

    dropLegacyTables(sqlite);
  });

  tx();

  recordMarker(sqlite);
  report.ran = true;

  logger.info(
    `[wiki-migration] Migrated ${report.pagesMigrated}/${report.pagesFound} wiki pages into ` +
      `memories (tagged wiki-origin, sector-routed, ${report.versionsMigrated} version-history ` +
      `entries preserved in metadata.wikiVersions). Links: ${report.linksResolved} resolved as ` +
      `canonical edges, ${report.linksUnresolved} unresolved dropped. Legacy wiki tables removed.`
  );

  return report;
}

function countLinks(sqlite: Database): { total: number; resolvable: number } {
  const total = (sqlite.prepare('SELECT COUNT(*) AS n FROM wiki_links').get() as any)?.n ?? 0;
  const resolvable =
    (
      sqlite
        .prepare(
          'SELECT COUNT(*) AS n FROM wiki_links WHERE target_page_id IS NOT NULL'
        )
        .get() as any
    )?.n ?? 0;
  return { total, resolvable };
}

function dropLegacyTables(sqlite: Database): void {
  // Order matters: children first (FK references).
  sqlite.exec('DROP TABLE IF EXISTS wiki_page_versions');
  sqlite.exec('DROP TABLE IF EXISTS wiki_links');
  sqlite.exec('DROP TABLE IF EXISTS wiki_pages');
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
