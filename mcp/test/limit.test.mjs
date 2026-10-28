import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

// A local API that counts requests and answers like the hosting platform does for an oversize body.
let hits = 0;
const api = createServer((req, res) => {
  hits++;
  req.resume();
  res.writeHead(413, { 'Content-Type': 'text/plain', 'X-Vercel-Error': 'FUNCTION_PAYLOAD_TOO_LARGE' }).end('Request Entity Too Large');
});
api.listen(0);
await once(api, 'listening');
process.env.VERIPORT_API_BASE = `http://127.0.0.1:${api.address().port}/api/v1`;
const { callTool, REQUEST_MAX_BYTES } = await import('../server.mjs');

test('validate_einvoice refuses a document over the limit without sending it', async () => {
  const r = await callTool('validate_einvoice', { xml: 'x'.repeat(REQUEST_MAX_BYTES + 1) });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'payload_too_large');
  assert.equal(hits, 0);
});

test('the platform bare 413 becomes payload_too_large', async () => {
  const r = await callTool('validate_einvoice', { xml: '<Invoice/>' });
  assert.equal(r.structuredContent.code, 'payload_too_large');
  assert.equal(hits, 1);
  api.close();
});
