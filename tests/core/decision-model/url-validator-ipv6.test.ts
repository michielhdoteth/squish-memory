/**
 * F1 regression: IPv6 loopback literals in the SSRF validator.
 *
 * WHATWG URL.hostname keeps the brackets for IPv6 literals ('[::1]'), so the
 * old set membership check never matched and loopback IPv6 URLs bypassed the
 * "localhost not allowed" block in strict mode. After the fix, the bracketed
 * form is normalized for the localhost and metadata-host checks, while the
 * allowLocalhost policy path is unchanged.
 */

import { describe, expect, test } from 'bun:test';
import { validateOutboundUrl } from '../../../core/lib/url-validator.js';

describe('validateOutboundUrl - IPv6 loopback (F1)', () => {
  test('strict mode blocks https://[::1] as a localhost URL', () => {
    expect(() => validateOutboundUrl('https://[::1]')).toThrow(/localhost/i);
    expect(() => validateOutboundUrl('https://[::1]:8443/v1/systemone')).toThrow(/localhost/i);
  });

  test('strict mode blocks ip6-localhost and ip6-loopback hostnames', () => {
    expect(() => validateOutboundUrl('https://ip6-localhost/v1')).toThrow(/localhost/i);
    expect(() => validateOutboundUrl('https://ip6-loopback/v1')).toThrow(/localhost/i);
  });

  test('allowLocalhost+allowHttp accepts http://[::1]:11435 (ollaya IPv6 bind)', () => {
    expect(() =>
      validateOutboundUrl('http://[::1]:11435/v1/systemone', { allowLocalhost: true, allowHttp: true }),
    ).not.toThrow();
  });

  test('non-loopback IPv6 literals are NOT localhost-blocked (scheme policy still applies)', () => {
    // https to a global IPv6 literal is a legitimate hosted endpoint shape:
    // it must not throw the localhost error (only scheme/host rules apply).
    expect(() => validateOutboundUrl('https://[2a00:1450:4001::1]/v1')).not.toThrow();
    expect(() => validateOutboundUrl('http://[2a00:1450:4001::1]/v1')).toThrow(/http|scheme/i);
  });

  test('private and metadata IPv4 behavior is unchanged', () => {
    expect(() => validateOutboundUrl('http://169.254.169.254/latest/meta-data', { allowHttp: true })).toThrow();
    expect(() => validateOutboundUrl('https://10.0.0.5/v1')).toThrow(/private|internal/i);
    expect(() => validateOutboundUrl('https://192.168.1.10/v1')).toThrow(/private|internal/i);
    expect(() => validateOutboundUrl('https://api.example.com/v1')).not.toThrow();
  });
});
