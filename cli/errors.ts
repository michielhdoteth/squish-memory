export function remediationFor(error: Error): string {
  const msg = error.message.toLowerCase();
  if (msg.includes('database') || msg.includes('sqlite')) return 'Run "squish doctor --fix" to repair the database';
  if (msg.includes('schema')) return 'Run "squish doctor --migrate" to update the schema';
  if (msg.includes('not found')) return 'Check the ID or query, or run "squish recall" to find memories';
  if (msg.includes('permission')) return 'Check file permissions on the data directory';
  if (msg.includes('enoent')) return 'Run "squish doctor" to verify installation integrity';
  return 'Run "squish doctor" for a full diagnostic';
}
