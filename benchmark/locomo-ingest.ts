import { readFileSync } from 'fs';
import type { LocomoConversation, LocomoTurn } from './locomo-types.js';

export function loadDataset(path: string): LocomoConversation[] {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

export function extractSessions(conv: LocomoConversation): Array<{ date: string; turns: LocomoTurn[] }> {
  const sessions: Array<{ date: string; turns: LocomoTurn[] }> = [];
  const convObj = conv.conversation;

  for (let i = 1; i <= 50; i++) {
    const dateKey = `session_${i}_date_time`;
    const sessionKey = `session_${i}`;

    if (convObj[dateKey] && convObj[sessionKey]) {
      sessions.push({
        date: convObj[dateKey],
        turns: convObj[sessionKey] as LocomoTurn[],
      });
    }
  }

  return sessions;
}

export function turnToMemory(turn: LocomoTurn, speakerA: string, speakerB: string, sessionDate: string): string {
  const role = turn.speaker === speakerA ? 'User' : 'Assistant';
  let content = `[${sessionDate}] ${role} (${turn.speaker}): ${turn.text}`;

  if (turn.blip_caption) {
    content += ` [Image: ${turn.blip_caption}]`;
  }

  return content;
}

export function buildSessionTag(convIndex: number, sessionIndex: number): string {
  return `locomo_conv${convIndex}_session${sessionIndex}`;
}
