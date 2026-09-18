/**
 * URL Validator -- SSRF Protection
 *
 * Validates outbound URLs before fetch() calls to prevent Server-Side Request
 * Forgery (SSRF) attacks. Blocks cloud metadata endpoints, private/internal
 * IPs, and optionally localhost depending on caller context.
 *
 * Usage:
 *   import { validateOutboundUrl } from '../lib/url-validator.js';
 *   validateOutboundUrl(url);                        // cloud provider (strict)
 *   validateOutboundUrl(url, { allowLocalhost: true }); // local provider (Ollama, LM Studio)
 */

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cloud metadata endpoints that must never be reachable */
const BLOCKED_HOSTS = new Set([
  '169.254.169.254',           // AWS / GCP / Azure metadata
  'metadata.google.internal',   // GCP metadata
  '100.100.100.200',           // Alibaba Cloud metadata
  'metadata.azure.internal',    // Azure metadata (internal suffix)
  'instance-data',              // Azure legacy metadata
]);

/** RFC 1918 + link-local + loopback IPv4 patterns */
const PRIVATE_IP_PATTERNS = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,           // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
  /^192\.168\.\d{1,3}\.\d{1,3}$/,               // 192.168.0.0/16
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,           // 127.0.0.0/8 (loopback)
  /^169\.254\.\d{1,3}\.\d{1,3}$/,               // 169.254.0.0/16 (link-local)
];

/** Hostnames that resolve to loopback */
const LOCALHOST_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateOutboundUrlOptions {
  /** Allow localhost / loopback URLs. Default: false (strict). */
  allowLocalhost?: boolean;
  /** Allow http: scheme (not just https:). Default: false. */
  allowHttp?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrivateIPv4(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an outbound URL before making a fetch() call.
 *
 * Throws an Error if the URL is blocked. Callers should catch and decide
 * whether to retry with a fallback or abort the operation.
 *
 * @param url      The URL string to validate
 * @param options  Validation options (allowLocalhost, allowHttp)
 */
export function validateOutboundUrl(
  url: string,
  options: ValidateOutboundUrlOptions = {},
): void {
  const { allowLocalhost = false, allowHttp = false } = options;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // --- Scheme check ---
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid URL scheme: ${parsed.protocol} (only http/https allowed)`);
  }

  if (parsed.protocol === 'http:' && !allowHttp) {
    throw new Error(`Insecure URL scheme: http:// (use https://) -- URL: ${url}`);
  }

  // --- Blocked metadata hostnames ---
  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    logger.warn(`[url-validator] Blocked metadata endpoint: ${url}`);
    throw new Error(`Blocked metadata endpoint: ${parsed.hostname}`);
  }

  // --- Localhost / loopback ---
  if (!allowLocalhost && LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
    logger.warn(`[url-validator] Blocked localhost URL: ${url}`);
    throw new Error(`Localhost URLs not allowed: ${url}`);
  }

  // --- Private / internal IPs ---
  if (isPrivateIPv4(parsed.hostname)) {
    // Allow loopback if explicitly permitted (for local providers)
    if (allowLocalhost && LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
      return; // already checked above, this is redundant but safe
    }
    // Allow link-local only if allowLocalhost is true
    if (parsed.hostname.startsWith('169.254.')) {
      logger.warn(`[url-validator] Blocked link-local IP: ${url}`);
      throw new Error(`Link-local IP not allowed: ${parsed.hostname}`);
    }
    // Block other private IPs regardless of allowLocalhost
    logger.warn(`[url-validator] Blocked private IP: ${url}`);
    throw new Error(`Private/internal IP not allowed: ${parsed.hostname}`);
  }
}
