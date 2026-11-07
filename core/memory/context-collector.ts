/** Context Collector - Collect recent conversation context for query rewriting */

import { logger } from '../logger.js';
import { getDb } from '../../db/index.js';
import { messages, conversations } from '../../db/drizzle/schema-sqlite.js';
import { eq, desc } from 'drizzle-orm';
import { isStrictTrustPolicy } from '../../core/acl/trust-policy.js';
import { denyStrictSurface } from '../../core/acl/trust-audit.js';

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export async function collectRecentContext(
  sessionId: string,
  count: number = 5
): Promise<ContextMessage[]> {
  if (isStrictTrustPolicy()) {
    return denyStrictSurface(
      sessionId || 'unscoped_context',
      'conversation_context',
      'Unscoped conversation context is disabled under strict trust until caller and project authorization are available',
    );
  }

  const db = await getDb();
  if (!db) {
    logger.warn('[ContextCollector] Database not available');
    return [];
  }

  try {
    const sqliteDb = db as any;
    const [conversation] = await sqliteDb
      .select()
      .from(conversations)
      .where(eq(conversations.sessionId, sessionId))
      .orderBy(desc(conversations.startedAt))
      .limit(1);

    if (!conversation) {
      logger.debug(`[ContextCollector] No conversation found for session ${sessionId}`);
      return [];
    }

    const recentMessages = await sqliteDb
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.createdAt))
      .limit(count);

    const ordered = recentMessages.reverse();

    return ordered.map((msg: typeof messages.$inferSelect) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
      createdAt: new Date(msg.createdAt ?? Date.now()),
    }));
  } catch (error) {
    logger.error('[ContextCollector] Failed to collect context:', error);
    return [];
  }
}

export function formatContextForLLM(messages: ContextMessage[]): string {
  if (messages.length === 0) return '';

  return messages
    .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
}

export async function getLastUserMessages(
  sessionId: string,
  count: number = 3
): Promise<string[]> {
  const context = await collectRecentContext(sessionId, count * 2);
  return context
    .filter(msg => msg.role === 'user')
    .slice(-count)
    .map(msg => msg.content);
}
