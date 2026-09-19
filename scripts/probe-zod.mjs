import { z } from 'zod';

const schema = z.object({
  name: z.string(),
  age: z.number(),
});

console.log('=== zod v4 probe ===');
console.log('zod.version:', typeof z.version === 'string' ? z.version : 'n/a');

const s = schema;
console.log('has _zod:', '_zod' in s);
const std = s['~standard'];
console.log('has ~standard:', !!std);

if (std) {
  try {
    console.log('~standard keys:', Object.keys(std));
  } catch (e) {
    console.log('~standard keys error:', e instanceof Error ? e.message : String(e));
  }
  try {
    const jsonSchema = std.jsonSchema;
    console.log('~standard.jsonSchema type:', typeof jsonSchema);
    const out = typeof jsonSchema === 'object' && jsonSchema && typeof jsonSchema.input === 'function' ? jsonSchema.input({ target: 'draft-2020-12' }) : undefined;
    console.log('~standard.jsonSchema.input(...):', JSON.stringify(out).slice(0, 200));
  } catch (e) {
    console.log('~standard.jsonSchema.input(...) error:', e instanceof Error ? e.message : String(e));
  }
}

try {
  const json = z.toJSONSchema(schema);
  console.log('z.toJSONSchema(schema):', JSON.stringify(json).slice(0, 200));
} catch (e) {
  console.log('z.toJSONSchema(schema) error:', e instanceof Error ? e.message : String(e));
}

try {
  const wrapped = z.object({ inner: schema });
  const json = z.toJSONSchema(wrapped);
  const inner = (json && json.properties && json.properties.inner) || undefined;
  console.log('z.toJSONSchema(wrapped).properties.inner exists:', !!inner);
  console.log('z.toJSONSchema(wrapped).properties.inner:', JSON.stringify(inner).slice(0, 200));
} catch (e) {
  console.log('z.toJSONSchema(wrapped) error:', e instanceof Error ? e.message : String(e));
}
