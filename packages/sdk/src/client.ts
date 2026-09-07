/**
 * @squish/sdk - SquishClient.
 *
 * A small, dependency-free MCP-over-HTTP client for a running squish
 * instance (local `squish-mcp --http` or cloud). One request path handles
 * auth, sessions, timeouts, retries, and error normalization.
 */

import {
  SquishError,
  SquishHttpError,
  SquishRpcError,
  SquishToolError,
  SquishTransportError,
} from './errors.js';
import type {
  CallToolResponse,
  ClientInfo,
  ContextInput,
  DedupInput,
  ExtractInput,
  FeedbackInput,
  ForgetInput,
  FetchLike,
  InspectInput,
  LinkInput,
  LoadoutInput,
  MaintenanceInput,
  PlacesInput,
  RecallInput,
  RecallResult,
  RememberInput,
  RememberResult,
  SkillInput,
  SquishClientOptions,
  SessionsInput,
  StatsInput,
  TierInput,
  ToolInfo,
  ToolResult,
} from './types.js';

/** Kept in sync with package.json version. */
export const SDK_VERSION = '2.1.0';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8767/mcp';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_BACKOFF_MS = 5_000;

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Client for a running squish memory instance over MCP streamable HTTP.
 *
 * @example
 * ```ts
 * import { SquishClient } from '@squish/sdk';
 *
 * const squish = new SquishClient({
 *   baseUrl: 'http://127.0.0.1:8767/mcp',
 *   apiKey: process.env.SQUISH_MCP_API_KEY,
 * });
 *
 * await squish.remember({ content: 'Use event-driven architecture' });
 * const recall = await squish.recall({ query: 'architecture decisions' });
 * console.log(recall.recallAssessment?.verdict);
 * await squish.close();
 * ```
 */
export class SquishClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly protocolVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly clientInfo: ClientInfo;
  private readonly fetchImpl: FetchLike;

  private sessionId: string | null = null;
  private sessionPromise: Promise<void> | null = null;
  private nextId = 1;

  constructor(options: SquishClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.clientInfo = options.clientInfo ?? { name: '@squish/sdk', version: SDK_VERSION };
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Current MCP session id, or null before the first call. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // ─── Generic surface ──────────────────────────────────────────────────────

  /**
   * Call any tool by name. Low-level escape hatch; prefer the typed methods.
   * Returns the first text content block parsed as JSON when possible,
   * otherwise the raw text.
   */
  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callToolRaw(tool, args);
    if (result.isError) {
      throw new SquishToolError(firstText(result) ?? `Tool ${tool} failed`);
    }
    return extractResult<T>(result);
  }

  /** List the tools exposed by the server. */
  async tools(): Promise<ToolInfo[]> {
    const result = await this.rpc<Record<string, unknown>>('tools/list');
    const tools = result['tools'];
    return Array.isArray(tools) ? (tools as ToolInfo[]) : [];
  }

  /**
   * Tear down the MCP session. Safe to call more than once; safe to keep
   * using the client afterwards (a fresh session is created on next call).
   */
  async close(): Promise<void> {
    const session = this.sessionId;
    this.sessionId = null;
    this.sessionPromise = null;
    if (!session) return;
    try {
      await this.fetchImpl(this.baseUrl, {
        method: 'DELETE',
        headers: this.headers(),
        signal: this.timeoutSignal().signal,
      });
    } catch {
      // Best effort - the server also reaps idle sessions.
    }
  }

  // ─── Typed tool methods ───────────────────────────────────────────────────

  /** Store a memory, learning, or ingest a media file (squish_remember). */
  async remember(input: RememberInput): Promise<RememberResult> {
    return this.call<RememberResult>('squish_remember', { ...input });
  }

  /** Recall by query (with calibrated verdict) or fetch by memory ID (squish_recall). */
  async recall(input: RecallInput): Promise<RecallResult> {
    return this.call<RecallResult>('squish_recall', {
      limit: 5,
      ...input,
    });
  }

  /** Delete by memory ID, or bulk-delete by search (squish_forget). */
  async forget(input: ForgetInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_forget', { ...input });
  }

  /** Find related memories or add a graph link (squish_link). */
  async link(input: LinkInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_link', { ...input });
  }

  /** Project context, project list, or session-start bootstrap (squish_context). */
  async context(input: ContextInput = {}): Promise<ToolResult> {
    return this.call<ToolResult>('squish_context', { limit: 10, ...input });
  }

  /** Stats, health, watchers, consolidation, traces, engines (squish_stats). */
  async stats(input: StatsInput = {}): Promise<ToolResult> {
    return this.call<ToolResult>('squish_stats', { ...input });
  }

  /** Explain why a memory was retained or routed (squish_inspect). */
  async inspect(input: InspectInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_inspect', { ...input });
  }

  /** Skills (SOPs) CRUD, search, assignment, usage (squish_skill). */
  async skill(input: SkillInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_skill', { ...input });
  }

  /** Agent loadouts and visibility rules (squish_loadout). */
  async loadout(input: LoadoutInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_loadout', { ...input });
  }

  /** Auto-extract skills from accumulated memories (squish_extract). */
  async extract(input: ExtractInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_extract', { ...input });
  }

  /** Reinforcement signals: confirm / used / contradict (squish_feedback). */
  async feedback(input: FeedbackInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_feedback', { ...input });
  }

  /** Memory places: list places or get memories at a place (squish_places). */
  async places(input: PlacesInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_places', { ...input });
  }

  /** Agent session history across harnesses (squish_sessions). */
  async sessions(input: SessionsInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_sessions', { ...input });
  }

  /** Memory tier management: pin / unpin / promote / stats (squish_tier). */
  async tier(input: TierInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_tier', { ...input });
  }

  /** Duplicate detection and merge workflow (squish_dedup). */
  async dedup(input: DedupInput): Promise<ToolResult> {
    return this.call<ToolResult>('squish_dedup', { ...input });
  }

  /**
   /** Database maintenance. Only available when the server was started with
    * SQUISH_ENABLE_MAINTENANCE_TOOLS=true (squish_maintenance).
    */
   async maintenance(input: MaintenanceInput): Promise<ToolResult> {
     return this.call<ToolResult>('squish_maintenance', { ...input });
   }

   /** Edit proposals and corrections. */
   async edit(input: EditInput): Promise<ToolResult> {
     return this.call<ToolResult>('squish_edits', { ...input });
   }

   async createEditProposal(input: EditProposalInput): Promise<ToolResult> {
     return this.edit({ action: 'createEditProposal', ...input });
   }

   async listEditProposals(input?: { memoryId?: string; status?: string; limit?: number }): Promise<ListEditProposalsResult> {
     return this.edit({ action: 'listEditProposals', ...input });
   }

   async previewEditProposal(proposalId: string): Promise<EditProposalPreview> {
     return this.edit({ action: 'previewEditProposal', proposalId });
   }

   async approveEditProposal(proposalId: string, reviewNotes?: string): Promise<ToolResult> {
     return this.edit({ action: 'approveEditProposal', proposalId, reviewNotes });
   }

   async rejectEditProposal(proposalId: string, reviewNotes?: string): Promise<ToolResult> {
     return this.edit({ action: 'rejectEditProposal', proposalId, reviewNotes });
   }

   async correctMemory(memoryId: string, content: string, reason: string): Promise<ToolResult> {
     return this.edit({ action: 'correctMemory', memoryId, content, reason });
   }

   /** Staleness report. */
   async stalenessReport(input: StalenessReportOptions = {}): Promise<StalenessReport> {
     return this.call<StalenessReport>('squish_stale_report', input);
   }

   // ─── Session lifecycle ────────────────────────────────────────────────────

  /** Establish the MCP session exactly once, even under concurrency. */
  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    this.sessionPromise ??= this.initializeSession();
    try {
      await this.sessionPromise;
    } catch (error) {
      this.sessionPromise = null;
      throw error;
    }
  }

  private async initializeSession(): Promise<void> {
    const response = await this.send(
      { jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      } },
      { attempt: 0 },
    );

    if (response.error) {
      throw new SquishRpcError(response.error.message, response.error.code, response.error.data);
    }

    const session = response.sessionId;
    if (!session) {
      throw new SquishError('Server did not return an mcp-session-id', 'SESSION_ERROR');
    }
    this.sessionId = session;

    // Spec-correct handshake; tolerated (202) or ignored by older servers.
    try {
      await this.send(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { attempt: 0, session, expectBody: false },
      );
    } catch {
      // Non-fatal: the e2e contract works without it.
    }
  }

  // ─── Request path (the single choke point) ────────────────────────────────

  private async callToolRaw(tool: string, args: Record<string, unknown>): Promise<CallToolResponse> {
    const result = await this.rpc<Record<string, unknown>>('tools/call', { name: tool, arguments: args });
    return result as unknown as CallToolResponse;
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureSession();

    let response: RpcResponse & { sessionId?: string };
    try {
      response = await this.send(
        { jsonrpc: '2.0', id: this.nextId++, method, params },
        { attempt: 0, session: this.sessionId! },
      );
    } catch (error) {
      // A 404 (or the server's 400/-32000) on a session we thought was alive
      // means the session expired or the server restarted - re-init once.
      if (isSessionExpired(error)) {
        this.sessionId = null;
        this.sessionPromise = null;
        await this.ensureSession();
        response = await this.send(
          { jsonrpc: '2.0', id: this.nextId++, method, params },
          { attempt: 0, session: this.sessionId! },
        );
      } else {
        throw error;
      }
    }

    if (response.error) {
      throw new SquishRpcError(response.error.message, response.error.code, response.error.data);
    }
    return response.result as T;
  }

  private async send(
    request: RpcRequest,
    opts: { attempt: number; session?: string; expectBody?: boolean },
  ): Promise<RpcResponse & { sessionId?: string }> {
    const { attempt, session, expectBody = true } = opts;

    let lastError: unknown;
    for (let tries = attempt; tries <= this.maxRetries; tries++) {
      const controller = this.timeoutSignal();
      try {
        const response = await this.fetchImpl(this.baseUrl, {
          method: 'POST',
          headers: this.headers(session),
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        if (RETRYABLE_STATUS.has(response.status)) {
          lastError = new SquishHttpError(
            `Request failed with status ${response.status}`,
            response.status,
            await safeText(response),
          );
          await this.backoff(tries, response.headers.get('retry-after'));
          continue;
        }

        if (!response.ok) {
          const body = await safeText(response);
          // Session-expired signature; let the caller re-initialize.
          if (response.status === 404 || (response.status === 400 && (body ?? '').includes('-32000'))) {
            const error = new SquishHttpError(`Session rejected (${response.status})`, response.status, body);
            (error as SquishError & { sessionExpired?: boolean }).sessionExpired = true;
            throw error;
          }
          throw new SquishHttpError(`Request failed with status ${response.status}`, response.status, body);
        }

        const sessionId = response.headers.get('mcp-session-id') ?? session;
        if (!expectBody) return { sessionId } as RpcResponse & { sessionId?: string };

        const parsed = await this.parseBody(response, request.id);
        return { ...parsed, sessionId };
      } catch (error) {
        if (isSessionExpired(error)) throw error;
        if (error instanceof SquishHttpError || error instanceof SquishRpcError) throw error;
        if (isTimeout(error)) {
          throw new SquishTransportError(
            `Request timed out after ${this.requestTimeoutMs}ms`,
            'TIMEOUT_ERROR',
            error,
          );
        }
        // Connection-level failure: the request never reached the server,
        // so retrying cannot double-apply anything.
        lastError = error;
        if (tries < this.maxRetries) {
          await this.backoff(tries);
          continue;
        }
      }
    }

    throw lastError instanceof SquishError
      ? lastError
      : new SquishTransportError(lastError instanceof Error ? lastError.message : 'Request failed', 'TRANSPORT_ERROR', lastError);
  }

  private async parseBody(response: Response, requestId: number | string | undefined): Promise<RpcResponse> {
    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown;

    if (contentType.includes('text/event-stream')) {
      payload = sseResponse(await response.text(), requestId);
    } else {
      const body = await response.text();
      try {
        payload = JSON.parse(body);
      } catch {
        throw new SquishTransportError(`Malformed JSON response: ${body.slice(0, 200)}`);
      }
    }

    // A stream may interleave notifications and responses; pick ours.
    if (Array.isArray(payload)) {
      const match = payload.find((m) => isRpcResponse(m, requestId));
      if (!match) throw new SquishTransportError('No matching response in stream');
      return match as RpcResponse;
    }
    if (!isRpcResponse(payload, requestId)) {
      throw new SquishTransportError('Unexpected response envelope');
    }
    return payload as RpcResponse;
  }

  private headers(session?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    if (session) headers['mcp-session-id'] = session;
    return headers;
  }

  private timeoutSignal(): AbortController {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    // Do not hold the event loop open for the timer alone.
    (timer as unknown as { unref?: () => void }).unref?.();
    return controller;
  }

  private async backoff(attempt: number, retryAfterHeader?: string | null): Promise<void> {
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1_000, MAX_BACKOFF_MS)
      : Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRpcResponse(payload: unknown, requestId: number | string | undefined): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as RpcResponse;
  if (candidate.jsonrpc !== '2.0') return false;
  // Notifications have no id and are never the response we wait for.
  return candidate.id !== undefined || requestId === undefined;
}

function sseResponse(text: string, requestId: number | string | undefined): RpcResponse | RpcResponse[] {
  const messages: RpcResponse[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as RpcResponse;
      if (isRpcResponse(parsed, requestId)) messages.push(parsed);
    } catch {
      // Ignore malformed frames (comments, keepalives).
    }
  }
  return messages;
}

function firstText(result: CallToolResponse): string | undefined {
  const block = result.content?.find((c) => c.type === 'text' && typeof c.text === 'string');
  return block?.text;
}

/**
 * Extract the tool payload: the server JSON-serializes its results into a
 * text block, so parse it back; fall back to the raw text.
 */
function extractResult<T>(result: CallToolResponse): T {
  const text = firstText(result);
  if (text === undefined) return result as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function isSessionExpired(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { sessionExpired?: boolean }).sessionExpired === true
  );
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  );
}
