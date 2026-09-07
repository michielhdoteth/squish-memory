import { z } from 'zod';

const schema = z.object({
  name: z.string(),
  age: z.number(),
});

console.log('=== zod v4 probe ===');
console.log('zod version inspect:', typeof (z as any).version === 'string' ? (z as any).version : 'n/a');

const s = schema;
console.log('has _zod:', '_zod' in s);
const std: any = (s as any)['~standard'];
console.log('has ~standard:', !!std);

if (std) {
  try {
    console.log('~standard keys:', Object.keys(std));
  } catch (e: any) {
    console.log('~standard keys error:', e?.message ?? String(e));
  }
  try {
    const out = std.jsonSchema?.input?.({ target: 'draft-2020-12' });
    console.log('~standard.jsonSchema.input(...):', JSON.stringify(out).slice(0, 200));
  } catch (e: any) {
    console.log('~standard.jsonSchema.input(...) error:', e?.message ?? String(e));
  }
}

try {
  const json = z.toJSONSchema(schema);
  console.log('z.toJSONSchema(schema):', JSON.stringify(json).slice(0, 200));
} catch (e: any) {
  console.log('z.toJSONSchema(schema) error:', e?.message ?? String(e));
}

try {
  const wrapped = z.object({ inner: schema });
  const json = z.toJSONSchema(wrapped);
  const inner = (json as any).properties?.inner;
  console.log('z.toJSONSchema(wrapped).properties.inner exists:', !!inner);
  console.log('z.toJSONSchema(wrapped).properties.inner:', JSON.stringify(inner).slice(0, 200));
} catch (e: any) {
  console.log('z.toJSONSchema(wrapped) error:', e?.message ?? String(e));
}
