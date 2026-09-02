// Type declarations for bin/runtime-launcher.mjs (plain JS, consumed by the CLI and bin entry points).

export interface ResolvedLaunch {
  command: string;
  args: string[];
}

export declare function resolveRuntimeLaunch(options: {
  rootDir: string;
  entryRelativePath: string;
  env?: Record<string, string | undefined>;
  extraArgs?: string[];
}): ResolvedLaunch;

export declare function getDefaultLogFile(serverName?: string): string;

export declare function attachChildLogging(child: unknown, logFilePath: string): unknown;
