/**
 * Singleton event bus for core modules.
 *
 * Import this in any core module to emit events:
 *   import { eventBus } from '../event-bus.js';
 *   eventBus.emit({ type: 'memory:stored', payload: { ... } });
 *
 * The bus is a DefaultEventBus from the SDK. Handlers are registered
 * by the MCP server, CLI, or any consumer that imports the SDK.
 */
import { DefaultEventBus } from '../packages/core-sdk/src/events/event-bus.js';
import type { SquishEvent } from '../packages/core-sdk/src/interfaces/events.js';
export declare const eventBus: DefaultEventBus;
/**
 * Convenience emitter that swallows errors (fire-and-forget).
 */
export declare function emit(event: SquishEvent): void;
//# sourceMappingURL=event-bus.d.ts.map