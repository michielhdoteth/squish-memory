/**
 * QMD MCP Client
 *
 * Connects to QMD (Quick Markdown Search) MCP server for hybrid search capabilities.
 * QMD provides BM25 full-text search, vector semantic search, and LLM re-ranking.
 *
 * Installation: install qmd globally with your package manager (for example: npm install -g qmd)
 * GitHub: https://github.com/tobi/qmd
 *
 * QMD MCP Tools:
 * - qmd_search: Fast BM25 keyword search
 * - qmd_vsearch: Semantic vector search
 * - qmd_query: Hybrid search with re-ranking (best quality)
 * - qmd_get: Retrieve document by path or docid
 * - qmd_multi_get: Retrieve multiple documents
 * - qmd_status: Index health and collection info
 */
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { spawn } from 'child_process';
import { config } from '../../config.js';
import { logger } from '../logger';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';

export interface QMDSearchOptions {
  query: string;
  collection?: string;
  limit?: number;
  minScore?: number;
}

export interface QMDSearchResult {
  docid: string;
  path: string;
  title: string;
  context: string;
  score: number;
  snippet: string;
}

export interface QMDStatusResult {
  indexHealth: string;
  collections: Array<{
    name: string;
    path: string;
    documentCount: number;
  }>;
}

export interface QMDGetOptions {
  pathOrDocid: string;
  full?: boolean;
  maxBytes?: number;
}

/**
 * QMD MCP Client class
 *
 * Manages connection to QMD MCP server and provides methods for
 * search, document retrieval, and status checking.
 */
export class QMDClient {
  private static readonly CONNECT_TIMEOUT_MS = 3_000;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private connecting = false;

  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly connectTimeoutMs = QMDClient.CONNECT_TIMEOUT_MS,
  ) {}

  private assertStrictAllowed(): void {
    if (!isStrictTrustPolicy()) return;
    resolveTrustedCallerId();
    throw new TrustBoundaryError('QMD access is unavailable under strict trust until collection scope and model-download egress are caller-bound');
  }

  private assertEnabled(): void {
    this.assertStrictAllowed();
    if (!config.qmdEnabled) {
      throw new TrustBoundaryError('QMD is disabled; set SQUISH_QMD_ENABLED=true to allow its local subprocess and possible model downloads');
    }
  }

  /**
   * Check if QMD is installed on the system
   */
  async checkQMDInstalled(): Promise<boolean> {
    this.assertStrictAllowed();
    if (!config.qmdEnabled) return false;
    return new Promise((resolve) => {
      const process = this.spawnProcess('qmd', ['--version'], {
        stdio: 'ignore'
      });
      let settled = false;
      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(available);
      };

      process.on('close', (code) => {
        finish(code === 0);
      });

      process.on('error', () => {
        finish(false);
      });

      const timeout = setTimeout(() => {
        process.kill();
        finish(false);
      }, this.connectTimeoutMs);
    });
  }

  /**
   * Connect to QMD MCP server
   * QMD must be installed globally and available on PATH
   */
  async connect(): Promise<boolean> {
    this.assertStrictAllowed();
    if (!config.qmdEnabled) {
      if (this.connected) await this.disconnect();
      return false;
    }
    if (this.connected || this.connecting) {
      return this.connected;
    }

    this.connecting = true;

    try {
      // Check if QMD is installed
      const installed = await this.checkQMDInstalled();
      // The install probe is asynchronous. Re-read both gates before starting
      // the MCP process so a revoked opt-in or newly selected strict policy
      // cannot be bypassed by an in-flight availability check.
      this.assertStrictAllowed();
      if (!config.qmdEnabled) {
        this.connecting = false;
        return false;
      }
      if (!installed) {
        logger.warn('QMD is not installed. Install it separately with your package manager, then retry.');
        this.connecting = false;
        return false;
      }

      this.transport = new StdioClientTransport({
        command: 'qmd',
        args: ['mcp'],
        stderr: 'inherit'
      });

      this.client = new Client(
        { name: 'squish-qmd-client', version: '1.0.0' },
        { capabilities: {} }
      );

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.client.connect(this.transport),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`QMD MCP connection timed out after ${this.connectTimeoutMs}ms`)),
              this.connectTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      this.connected = true;
      this.connecting = false;
      logger.info('Connected to QMD MCP server');
      return true;
    } catch (error) {
      logger.warn(`QMD MCP connection failed: ${error}`);
      const transport = this.transport;
      this.client = null;
      this.transport = null;
      this.connected = false;
      this.connecting = false;
      if (transport) {
        // A timed-out handshake must not leave the optional subprocess alive.
        void transport.close().catch((closeError: unknown) => {
          logger.debug(`Error closing timed-out QMD transport: ${closeError}`);
        });
      }
      return false;
    }
  }

  /**
   * Check if QMD is available
   */
  async isAvailable(): Promise<boolean> {
    this.assertStrictAllowed();
    if (!config.qmdEnabled) {
      if (this.connected) await this.disconnect();
      return false;
    }
    if (this.connected && this.client) {
      return true;
    }
    return await this.connect();
  }

  /**
   * Fast BM25 keyword search
   * Uses SQLite FTS5 for fast full-text search
   */
  async search(options: QMDSearchOptions): Promise<QMDSearchResult[]> {
    this.assertEnabled();
    if (!this.connected || !this.client) {
      throw new Error('QMD client not connected');
    }

    const result = await this.client.callTool({
      name: 'qmd_search',
      arguments: {
        query: options.query,
        collection: options.collection,
        n: options.limit || 10,
        minScore: options.minScore || 0
      }
    }) as any;

    return this.parseSearchResults(result);
  }

  /**
   * Semantic vector search
   * Uses embedding-based similarity search
   */
  async vsearch(options: QMDSearchOptions): Promise<QMDSearchResult[]> {
    this.assertEnabled();
    if (!this.connected || !this.client) {
      throw new Error('QMD client not connected');
    }

    const result = await this.client.callTool({
      name: 'qmd_vsearch',
      arguments: {
        query: options.query,
        collection: options.collection,
        n: options.limit || 10,
        minScore: options.minScore || 0
      }
    }) as any;

    return this.parseSearchResults(result);
  }

  /**
   * Hybrid search with re-ranking (best quality)
   * Combines BM25 + vector search + LLM re-ranking
   */
  async query(options: QMDSearchOptions): Promise<QMDSearchResult[]> {
    this.assertEnabled();
    if (!this.connected || !this.client) {
      throw new Error('QMD client not connected');
    }

    const result = await this.client.callTool({
      name: 'qmd_query',
      arguments: {
        query: options.query,
        collection: options.collection,
        n: options.limit || 10,
        minScore: options.minScore || 0
      }
    }) as any;

    return this.parseSearchResults(result);
  }

  /**
   * Get QMD index status and collection info
   */
  async status(): Promise<QMDStatusResult | null> {
    this.assertEnabled();
    if (!this.connected || !this.client) {
      return null;
    }

    try {
      const result = await this.client.callTool({
        name: 'qmd_status',
        arguments: {}
      }) as any;

      return this.parseStatusResult(result);
    } catch (error) {
      logger.debug(`QMD status check failed: ${error}`);
      return null;
    }
  }

  /**
   * Get document by path or docid
   */
  async get(options: QMDGetOptions): Promise<string> {
    this.assertEnabled();
    if (!this.connected || !this.client) {
      throw new Error('QMD client not connected');
    }

    const args: Record<string, any> = {
      path: options.pathOrDocid
    };

    if (options.full !== undefined) {
      args.full = options.full;
    }
    if (options.maxBytes !== undefined) {
      args['max-bytes'] = options.maxBytes;
    }

    const result = await this.client.callTool({
      name: 'qmd_get',
      arguments: args
    }) as any;

    return this.parseGetResult(result);
  }

  /**
   * Get multiple documents by glob pattern or list
   */
  async multiGet(patternOrList: string | string[], options?: { maxBytes?: number; limit?: number }): Promise<string[]> {
    this.assertEnabled();
    if (!this.connected || !this.client) {
      throw new Error('QMD client not connected');
    }

    const args: Record<string, any> = {
      pattern: Array.isArray(patternOrList) ? patternOrList.join(',') : patternOrList
    };

    if (options?.maxBytes !== undefined) {
      args['max-bytes'] = options.maxBytes;
    }
    if (options?.limit !== undefined) {
      args.l = options.limit;
    }

    const result = await this.client.callTool({
      name: 'qmd_multi_get',
      arguments: args
    }) as any;

    return this.parseMultiGetResult(result);
  }

  /**
   * Disconnect from QMD MCP server
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        logger.debug(`Error closing QMD client: ${error}`);
      }
      this.connected = false;
      this.client = null;
      this.transport = null;
    }
  }

  /**
   * Parse search results from QMD response
   */
  private parseSearchResults(result: any): QMDSearchResult[] {
    if (!result || !result.content) {
      return [];
    }

    const content = result.content;

    // Handle text output format
    if (typeof content === 'string') {
      return this.parseTextSearchResults(content);
    }

    // Handle array content format
    if (Array.isArray(content)) {
      const textContent = content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n');
      return this.parseTextSearchResults(textContent);
    }

    return [];
  }

  /**
   * Parse QMD's text output format into structured results
   */
  private parseTextSearchResults(text: string): QMDSearchResult[] {
    const results: QMDSearchResult[] = [];
    const lines = text.split('\n');

    let currentResult: Partial<QMDSearchResult> | null = null;

    for (const line of lines) {
      // Match path line: "docs/guide.md:42 #a1b2c3"
      const pathMatch = line.match(/^([^\s:]+):(\d+)\s+([#a-zA-Z0-9]+)?/);
      if (pathMatch) {
        if (currentResult && currentResult.path) {
          results.push(this.finalizeResult(currentResult));
        }
        currentResult = {
          path: pathMatch[1],
          docid: pathMatch[3] || '',
          score: 0,
          snippet: ''
        };
        continue;
      }

      // Match score line: "Score: 93%"
      const scoreMatch = line.match(/^Score:\s+(\d+)%/);
      if (scoreMatch && currentResult) {
        currentResult.score = parseInt(scoreMatch[1]) / 100;
        continue;
      }

      // Match title line: "Title: Some Title"
      const titleMatch = line.match(/^Title:\s+(.+)/);
      if (titleMatch && currentResult) {
        currentResult.title = titleMatch[1];
        continue;
      }

      // Match context line: "Context: Some context"
      const contextMatch = line.match(/^Context:\s+(.+)/);
      if (contextMatch && currentResult) {
        currentResult.context = contextMatch[1];
        continue;
      }

      // Collect snippet content
      if (currentResult && line.trim() && !line.startsWith('---')) {
        currentResult.snippet += line + '\n';
      }
    }

    // Don't forget the last result
    if (currentResult && currentResult.path) {
      results.push(this.finalizeResult(currentResult));
    }

    return results;
  }

  /**
   * Finalize a parsed result with defaults
   */
  private finalizeResult(result: Partial<QMDSearchResult>): QMDSearchResult {
    return {
      path: result.path || '',
      docid: result.docid || '',
      title: result.title || result.path?.split('/').pop() || '',
      context: result.context || '',
      score: result.score || 0,
      snippet: (result.snippet || '').trim()
    };
  }

  /**
   * Parse status result
   */
  private parseStatusResult(result: any): QMDStatusResult | null {
    if (!result || !result.content) {
      return null;
    }

    const content = result.content;
    if (typeof content === 'string') {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    if (Array.isArray(content)) {
      const textContent = content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('');
      try {
        return JSON.parse(textContent);
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Parse get result
   */
  private parseGetResult(result: any): string {
    if (!result || !result.content) {
      return '';
    }

    const content = result.content;
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n');
    }

    return '';
  }

  /**
   * Parse multi-get result
   */
  private parseMultiGetResult(result: any): string[] {
    const text = this.parseGetResult(result);
    if (!text) {
      return [];
    }

    // Split by document separators and return individual documents
    return text.split(/\n---+\n/).filter(doc => doc.trim());
  }
}

// Singleton instance
let qmdClientInstance: QMDClient | null = null;

/**
 * Get the singleton QMD client instance
 */
export async function getQMDClient(): Promise<QMDClient> {
  if (!qmdClientInstance) {
    qmdClientInstance = new QMDClient();
  }
  return qmdClientInstance;
}

/**
 * Reset the singleton QMD client (useful for testing)
 */
export function resetQMDClient(): void {
  if (qmdClientInstance) {
    qmdClientInstance.disconnect().catch(() => {});
    qmdClientInstance = null;
  }
}
