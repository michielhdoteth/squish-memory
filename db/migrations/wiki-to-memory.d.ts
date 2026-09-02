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
 * Resolvable [[wikilinks]] become graph associations: every wiki_links row
 * whose target resolved to a real page becomes a 'relates_to' association
 * between the two migrated memory rows.
 *
 * Gating:
 * - Marker row '2.2.0-wiki-to-memory' in _schema_versions makes it one-time
 *   and idempotent.
 * - SQUISH_WIKI_MIGRATE_DRY_RUN=true previews counts without writing and
 *   leaves the marker unset so a later apply still runs.
 * - Fresh installs (no wiki_pages table) just record the marker.
 */
import type { Database } from 'better-sqlite3';
export declare const WIKI_TO_MEMORY_MARKER = "2.2.0-wiki-to-memory";
export interface WikiMigrationReport {
    ran: boolean;
    dryRun: boolean;
    pagesFound: number;
    pagesMigrated: number;
    versionsMigrated: number;
    linksResolved: number;
    linksUnresolved: number;
}
/**
 * Run the one-time wiki -> memory migration.
 * Called from ensureSqliteSchema after regular migrations.
 */
export declare function runWikiToMemoryMigration(sqlite: Database, options?: {
    dryRun?: boolean;
}): WikiMigrationReport;
//# sourceMappingURL=wiki-to-memory.d.ts.map