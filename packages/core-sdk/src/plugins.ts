import type { PluginHook, PluginHookContext } from './types.js';

/**
 * A plugin that hooks into SDK lifecycle events.
 */
export interface Plugin {
  /** Unique plugin name */
  name: string;
  /** Hook handlers keyed by hook name */
  hooks: Partial<Record<PluginHook, (ctx: PluginHookContext) => Promise<void> | void>>;
}

/**
 * Registry for managing and executing plugin hooks.
 */
export class PluginRegistry {
  private plugins: Plugin[] = [];

  /**
   * Register a plugin.
   * @param plugin - The plugin to register
   */
  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Execute all registered handlers for a given hook.
   * @param hook - The hook point to execute
   * @param ctx - The context to pass to handlers
   */
  async executeHook(hook: PluginHook, ctx: PluginHookContext): Promise<void> {
    for (const plugin of this.plugins) {
      const handler = plugin.hooks[hook];
      if (handler) {
        await handler(ctx);
      }
    }
  }
}
