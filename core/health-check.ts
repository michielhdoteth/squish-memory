/**
 * Health check module for doctor command.
 * Runs basic checks on the database and schema.
 */

import { probeSchemaHealth } from '../db/schema-probe.js';
import { checkDatabaseHealth } from '../db/index.js';

export interface HealthCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface HealthReport {
  healthy: boolean;
  checks: HealthCheck[];
}

export async function runHealthChecks(): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  // Schema check
  try {
    const probe = await probeSchemaHealth();
    checks.push({
      name: 'Schema',
      ok: probe.status === 'ok',
      message: probe.status === 'ok'
        ? `All tables present (${probe.backend})`
        : `Schema issues: ${probe.detail || probe.status}`,
    });
  } catch (error: any) {
    checks.push({
      name: 'Schema',
      ok: false,
      message: `Schema check failed: ${error.message}`,
    });
  }

  // Database connectivity check
  try {
    const healthy = await checkDatabaseHealth();
    checks.push({
      name: 'Database',
      ok: healthy,
      message: healthy ? 'Database accessible' : 'Database health check failed',
    });
  } catch (error: any) {
    checks.push({
      name: 'Database',
      ok: false,
      message: `Database check failed: ${error.message}`,
    });
  }

  return {
    healthy: checks.every((c) => c.ok),
    checks,
  };
}
