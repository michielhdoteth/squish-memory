/**
 * Core Memory Service - Always-in-context memory (Tier 1)
 *
 * Small, persistent, always-visible memory block (< 2KB total).
 * This memory is automatically injected into every agent interaction.
 */

import { eq, and, sql } from 'drizzle-orm';
import { getDbClient, type DbClient } from '../lib/db-client.js';
import config from '../../config.js';
import { estimateTokens } from '../context/context-window.js';

type CoreMemorySection = 'persona' | 'user_info' | 'project_context' | 'working_notes';

// Use configurable limits from environment
const MAX_TOTAL_SIZE_BYTES = config.coreMemoryTotalBytes;
const MAX_SECTION_SIZE_BYTES = config.coreMemorySectionBytes;

interface CoreMemoryContent {
  persona: string;
  user_info: string;
  project_context: string;
  working_notes: string;
}

/**
 * Initialize core memory for a project
 */
export async function initializeCoreMemory(projectId: string, userId?: string): Promise<void> {
  const { db, schema } = await getDbClient();
  const { coreMemory } = schema;

  const sections: CoreMemorySection[] = ['persona', 'user_info', 'project_context', 'working_notes'];

  for (const section of sections) {
    const existing = await db
      .select()
      .from(coreMemory)
      .where(
        and(
          eq(coreMemory.projectId, projectId as any),
          eq(coreMemory.section, section)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(coreMemory).values({
        projectId: projectId as any,
        userId: userId as any,
        section,
        content: '',
        sizeBytes: 0,
        version: 1,
      } as any);
    }
  }
}

/**
 * Get all core memory sections for a project
 */
export async function getCoreMemory(projectId: string): Promise<CoreMemoryContent> {
  const { db, schema } = await getDbClient();
  const { coreMemory } = schema;

  const sections = await db
    .select()
    .from(coreMemory)
    .where(eq(coreMemory.projectId, projectId as any));

  const content: CoreMemoryContent = {
    persona: '',
    user_info: '',
    project_context: '',
    working_notes: '',
  };

  for (const section of sections) {
    const key = section.section as keyof CoreMemoryContent;
    content[key] = section.content || '';
  }

  return content;
}

/**
 * Get a specific core memory section
 */
export async function getCoreMemorySection(
  projectId: string,
  section: CoreMemorySection
): Promise<string> {
  const { db, schema } = await getDbClient();
  const { coreMemory } = schema;

  const result = await db
    .select()
    .from(coreMemory)
    .where(
      and(
        eq(coreMemory.projectId, projectId as any),
        eq(coreMemory.section, section)
      )
    )
    .limit(1);

  return result[0]?.content || '';
}

/**
 * Update (replace) a core memory section
 */
export async function editCoreMemorySection(
  projectId: string,
  section: CoreMemorySection,
  content: string
): Promise<{ success: boolean; message?: string; sizeBytes?: number; tokensEstimate?: number }> {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const tokensEstimate = estimateTokens(content);

  // Check section size limit
  if (sizeBytes > MAX_SECTION_SIZE_BYTES) {
    return {
      success: false,
      message: `Content exceeds section limit of ${MAX_SECTION_SIZE_BYTES} bytes (got ${sizeBytes} bytes)`,
    };
  }

  // Check total size limit
  const totalSize = await getTotalCoreMemorySize(projectId, section, sizeBytes);
  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    return {
      success: false,
      message: `Total core memory would exceed ${MAX_TOTAL_SIZE_BYTES} bytes (would be ${totalSize} bytes)`,
    };
  }

  const { db, schema } = await getDbClient();
  const { coreMemory } = schema;

  await db
    .update(coreMemory)
    .set({
      content,
      sizeBytes,
      tokensEstimate,
      version: sql`${coreMemory.version} + 1`,
      updatedAt: new Date() as any,
    } as any)
    .where(
      and(
        eq(coreMemory.projectId, projectId as any),
        eq(coreMemory.section, section)
      )
    );

  return { success: true, sizeBytes, tokensEstimate };
}

/**
 * Append content to a core memory section
 */
export async function appendCoreMemorySection(
  projectId: string,
  section: CoreMemorySection,
  text: string
): Promise<{ success: boolean; message?: string; sizeBytes?: number }> {
  const currentContent = await getCoreMemorySection(projectId, section);
  const newContent = currentContent ? `${currentContent}\n${text}` : text;

  return editCoreMemorySection(projectId, section, newContent);
}

/**
 * Replace text within a core memory section
 */
export async function replaceCoreMemoryText(
  projectId: string,
  section: CoreMemorySection,
  oldText: string,
  newText: string
): Promise<{ success: boolean; message?: string; sizeBytes?: number }> {
  const currentContent = await getCoreMemorySection(projectId, section);

  if (!currentContent.includes(oldText)) {
    return {
      success: false,
      message: `Text "${oldText}" not found in section "${section}"`,
    };
  }

  const newContent = currentContent.replace(oldText, newText);
  return editCoreMemorySection(projectId, section, newContent);
}

/**
 * Get total size of core memory (excluding one section if calculating new size)
 */
async function getTotalCoreMemorySize(
  projectId: string,
  excludeSection?: CoreMemorySection,
  newSectionSize?: number
): Promise<number> {
  const { db, schema } = await getDbClient();
  const { coreMemory } = schema;

  const sections = await db
    .select()
    .from(coreMemory)
    .where(eq(coreMemory.projectId, projectId as any));

  let total = 0;
  for (const section of sections) {
    if (section.section === excludeSection) {
      total += newSectionSize || 0;
    } else {
      total += section.sizeBytes || 0;
    }
  }

  return total;
}

/**
 * Get core memory stats
 */
export async function getCoreMemoryStats(projectId: string): Promise<{
  totalBytes: number;
  totalTokens: number;
  maxBytes: number;
  maxTokens: number;
  usagePercent: number;
  tokenUsagePercent: number;
  sections: Array<{
    section: string;
    sizeBytes: number;
    tokensEstimate: number;
    version: number;
    updatedAt: Date;
  }>;
}> {
  const { db, schema } = await getDbClient();
  const { coreMemory } = schema;

  const sections = await db
    .select()
    .from(coreMemory)
    .where(eq(coreMemory.projectId, projectId as any));

  const totalBytes = sections.reduce((sum: number, s: any) => sum + (s.sizeBytes || 0), 0);
  const totalTokens = sections.reduce((sum: number, s: any) => sum + (s.tokensEstimate || 0), 0);

  // Estimate max tokens from max bytes (rough approximation: 1 token ≈ 4 chars)
  const maxTokens = Math.floor(MAX_TOTAL_SIZE_BYTES / 4);

  return {
    totalBytes,
    totalTokens,
    maxBytes: MAX_TOTAL_SIZE_BYTES,
    maxTokens,
    usagePercent: (totalBytes / MAX_TOTAL_SIZE_BYTES) * 100,
    tokenUsagePercent: (totalTokens / maxTokens) * 100,
    sections: sections.map((s: any) => ({
      section: s.section,
      sizeBytes: s.sizeBytes || 0,
      tokensEstimate: s.tokensEstimate || 0,
      version: s.version || 1,
      updatedAt: s.updatedAt,
    })),
  };
}

/**
 * Estimate token count from text (rough approximation: 1 token ≈ 4 chars)
 * Import from context-window.ts - single source of truth
 */
export { estimateTokens } from '../context/context-window.js';

/**
 * Get core memory formatted for context injection
 */
export async function formatCoreMemoryForInjection(projectId: string): Promise<string> {
  const content = await getCoreMemory(projectId);
  const stats = await getCoreMemoryStats(projectId);

  let formatted = `# Core Memory (Always-In-Context)\n\n`;

  if (content.persona) {
    formatted += `## Agent Persona\n${content.persona}\n\n`;
  }

  if (content.user_info) {
    formatted += `## User Information\n${content.user_info}\n\n`;
  }

  if (content.project_context) {
    formatted += `## Project Context\n${content.project_context}\n\n`;
  }

  if (content.working_notes) {
    formatted += `## Working Notes\n${content.working_notes}\n\n`;
  }

  formatted += `---\n`;
  formatted += `Core Memory Usage:\n`;
  formatted += `- Bytes: ${stats.totalBytes}/${stats.maxBytes} (${stats.usagePercent.toFixed(1)}%)\n`;
  formatted += `- Tokens: ~${stats.totalTokens}/${stats.maxTokens} (${stats.tokenUsagePercent.toFixed(1)}%)\n\n`;

  // Add tool usage hints for agent-driven retrieval
  formatted += `### Memory Tools Available\n`;
  formatted += `When you need to recall information or store something important, use these tools:\n`;
  formatted += `- **Search**: Use \`/squish:search\` to find stored memories matching a query\n`;
  formatted += `- **Store**: Use \`/squish:remember\` to save new information for future use\n`;
  formatted += `- **Update Core Memory**: Use \`/squish:core-memory\` to edit this always-visible memory\n`;

  return formatted;
}
