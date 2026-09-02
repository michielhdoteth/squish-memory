// Type declarations for bin/installer-core.mjs (plain JS, consumed by the CLI).

export declare const SUPPORTED_AGENTS: string[];

export declare function getClientName(client: string): string;

export declare function detectClients(): string[];

export interface ShadowIssue {
  command: string;
  first?: string;
  alternates: string[];
  [key: string]: unknown;
}

export declare function checkShadowIssues(): ShadowIssue[];

export interface InstallStep {
  type: string;
  ok: boolean;
  error?: string;
  path?: string;
  [key: string]: unknown;
}

export declare function installAll(clients: string[], options?: Record<string, unknown>): Record<string, InstallStep[]>;

export declare function uninstallAll(
  clients: string[],
  options?: Record<string, unknown>,
): Record<string, InstallStep[]>;

export declare function getInstalledClients(): Array<{ client: string; installed: string[] }>;
