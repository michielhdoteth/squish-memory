import { AsyncLocalStorage } from 'node:async_hooks';

const requestPrincipal = new AsyncLocalStorage<string | undefined>();

/** Run one MCP request with the identity attached by the authenticated transport. */
export function withRequestPrincipal<T>(principalId: string | undefined, callback: () => T): T {
  return requestPrincipal.run(principalId || undefined, callback);
}

/** Return only the principal attached by the trusted MCP transport wrapper. */
export function getRequestPrincipal(): string | null {
  return requestPrincipal.getStore() ?? null;
}
