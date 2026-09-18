/**
 * Singleton event bus for core modules.
 *
 * Import this in any core module to emit events:
 *   import { eventBus } from '../event-bus.js';
 *   eventBus.emit({ type: 'memory:stored', payload: { ... } });
 */

// --- Inlined from deleted core-sdk/src/interfaces/events.ts ---

export type SquishEvent = { type: string; payload: Record<string, unknown> };

export type SquishEventHandler = (event: SquishEvent) => void;

// --- Inlined from deleted core-sdk/src/events/event-bus.ts ---

export class DefaultEventBus {
  private handlers: SquishEventHandler[] = [];

  on(handler: SquishEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(event: SquishEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // swallow handler errors
      }
    }
  }
}

export const eventBus = new DefaultEventBus();

/** Convenience re-export: emit(event) wraps eventBus.emit(event) */
export function emit(event: SquishEvent): void {
  eventBus.emit(event);
}
