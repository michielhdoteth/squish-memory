/**
 * DefaultEventBus — concrete EventBus implementation for the SDK.
 *
 * Fire-and-forget: emit() never throws. Handlers that throw have their
 * errors logged to stderr and swallowed.
 */
import type { EventBus, SquishEvent } from '../interfaces/events.js';

type Handler = (event: SquishEvent) => void | Promise<void>;

export class DefaultEventBus implements EventBus {
  private listeners = new Map<string, Set<Handler>>();
  private onceListeners = new Map<string, Set<Handler>>();

  emit(event: SquishEvent): void {
    const handlers = this.listeners.get(event.type);
    const onceHandlers = this.onceListeners.get(event.type);

    if (handlers) {
      for (const handler of handlers) {
        this.invoke(handler, event);
      }
    }

    if (onceHandlers) {
      for (const handler of onceHandlers) {
        this.invoke(handler, event);
      }
      onceHandlers.clear();
    }
  }

  on<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    const key = eventType as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(handler as Handler);

    return () => this.off(eventType, handler);
  }

  off<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): void {
    const key = eventType as string;
    this.listeners.get(key)?.delete(handler as Handler);
  }

  once<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    const key = eventType as string;
    if (!this.onceListeners.has(key)) {
      this.onceListeners.set(key, new Set());
    }
    this.onceListeners.get(key)!.add(handler as Handler);

    return () => this.onceListeners.get(key)?.delete(handler as Handler);
  }

  /** Remove all listeners (useful for testing). */
  clear(): void {
    this.listeners.clear();
    this.onceListeners.clear();
  }

  /** Number of active listeners (for diagnostics). */
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    for (const set of this.onceListeners.values()) count += set.size;
    return count;
  }

  private invoke(handler: Handler, event: SquishEvent): void {
    try {
      const result = handler(event);
      if (result && typeof result === 'object' && 'catch' in result) {
        (result as Promise<void>).catch((err) => {
          console.error(`[event-bus] handler error for ${event.type}:`, err);
        });
      }
    } catch (err) {
      console.error(`[event-bus] handler error for ${event.type}:`, err);
    }
  }
}
