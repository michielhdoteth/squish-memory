/**
 * Ambient declarations for the OpenClaw plugin host.
 *
 * `openclaw/plugin-sdk/plugin-entry` is provided by the OpenClaw gateway at
 * plugin load time and `@sinclair/typebox` is resolved by that host, so
 * neither is a dependency of this package and both fail module resolution
 * under this tsconfig. These declarations cover only the surface that
 * `plugins/openclaw/index.ts` actually uses; parameter and result types are
 * taken from that usage rather than from the upstream package.
 *
 * If either package is ever added as a real dependency, delete this file so
 * the shipped types win over these stand-ins.
 */

declare module '@sinclair/typebox' {
  /**
   * A compiled schema object. The host validates tool input against it; the
   * plugin only constructs and passes it through, so the shape stays open.
   */
  export interface TSchema {
    readonly [key: string]: unknown;
  }

  /** Options accepted by the scalar schemas below. */
  export interface SchemaOptions {
    description?: string;
  }

  export const Type: {
    String(options?: SchemaOptions): TSchema;
    Number(options?: SchemaOptions): TSchema;
    Boolean(options?: SchemaOptions): TSchema;
    Optional(schema: TSchema): TSchema;
    Object(properties: Record<string, TSchema>): TSchema;
  };
}

declare module 'openclaw/plugin-sdk/plugin-entry' {
  import type { TSchema } from '@sinclair/typebox';

  /**
   * Config the host hands the plugin, matching the `configSchema` object
   * the entry declares below.
   */
  export interface PluginConfig {
    dataDir?: string;
    autoCapture?: boolean;
    contextLimit?: number;
  }

  /**
   * Parsed tool arguments as passed to `execute`. This is the aggregate of
   * the fields this plugin's four tools declare in their `parameters`
   * schemas: `content` and `query` are read straight into the squish CLI
   * argv (so they are non-optional), while `type`, `place` and `limit` are
   * read behind a `||` default.
   */
  export interface ToolArgs {
    content: string;
    query: string;
    type?: string;
    place?: string;
    limit?: number;
  }

  /** What a tool handler returns to the host. */
  export interface ToolResult {
    content: Array<{ type: string; text: string }>;
  }

  export interface ToolDefinition {
    name: string;
    description: string;
    parameters: TSchema;
    execute(id: string, params: ToolArgs): Promise<ToolResult>;
  }

  /**
   * Context passed to lifecycle hook handlers. `session_end` reads
   * `messages` and `session_start` reads `workingDirectory`, so both are
   * declared; the rest of the context is left open to the host.
   */
  export interface SessionContext {
    workingDirectory: string;
    messages?: Array<{ role?: string; content?: string }>;
  }

  /** Injection payload a `session_start` handler may return. */
  export interface HookResult {
    messages: Array<{ role: string; content: string }>;
  }

  export type HookHandler = (
    context: SessionContext,
  ) => HookResult | void | Promise<HookResult | void>;

  export interface PluginApi {
    registrationMode: string;
    pluginConfig: PluginConfig;
    workingDirectory: string;
    registerTool(definition: ToolDefinition): void;
    on(
      event: string,
      handler: HookHandler,
      options?: { priority?: number },
    ): void;
    logger: { info(message: string): void };
  }

  export interface PluginEntry {
    id: string;
    name: string;
    description: string;
    kind: string;
    configSchema: TSchema;
    register(api: PluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
