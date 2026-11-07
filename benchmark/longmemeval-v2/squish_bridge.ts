import { createInterface } from 'node:readline';

const dataDir = process.env.SQUISH_DATA_DIR;
if (!dataDir) throw new Error('SQUISH_DATA_DIR is required for an isolated LongMemEval-V2 run');
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
process.env.SQUISH_ALLOW_MODEL_DOWNLOADS = 'false';
process.env.SQUISH_TRUST_POLICY = 'local-compatible';
process.env.SQUISH_PROFILE = 'fast-local';
process.env.SQUISH_LLM_ENABLED = 'false';
process.env.SQUISH_GRAPH_AUTO_BUILD = 'false';
process.env.SQUISH_SKIP_CONTRADICTION = 'true';
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);
console.error = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(' ')}\n`);

const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
const runtime = new SquishRuntime({ dataDir, project: process.env.SQUISH_LMEV2_PROJECT ?? process.cwd() });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;
  let request: { id?: string; op?: string; payload?: Record<string, unknown> };
  try {
    request = JSON.parse(line) as typeof request;
    const payload = request.payload ?? {};
    if (request.op === 'insert') {
      const content = String(payload.content ?? '').trim();
      if (!content) throw new Error('trajectory produced no text content');
      const memory = await runtime.remember(content, {
        type: 'context',
        tags: ['longmemeval-v2', 'trajectory-evidence'],
        project: process.env.SQUISH_LMEV2_PROJECT ?? process.cwd(),
        metadata: {
          source: 'longmemeval-v2',
          trajectoryId: String(payload.trajectoryId ?? ''),
          screenshots: Array.isArray(payload.screenshots) ? payload.screenshots : [],
          domain: String(payload.domain ?? ''),
        },
      });
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { memoryId: memory.id } })}\n`);
      continue;
    }
    if (request.op === 'query') {
      const question = String(payload.query ?? '').trim();
      if (!question) throw new Error('query must not be empty');
      const result = await runtime.recall(question, { limit: 8, project: process.env.SQUISH_LMEV2_PROJECT ?? process.cwd() });
      const memories = result.memories.map((memory) => ({
        id: memory.id,
        content: memory.content,
        metadata: memory.metadata ?? {},
      }));
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { memories } })}\n`);
      continue;
    }
    if (request.op === 'close') {
      await runtime.close();
      process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: null })}\n`);
      break;
    }
    throw new Error(`unsupported operation: ${String(request.op)}`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id: request?.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
  }
}
