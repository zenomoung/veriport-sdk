import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/** A fake Veriport API: records the requests, answers canned bodies and the limit states. */
async function fakeApi() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null });
    const url = new URL(req.url, 'http://x');
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/vat/validate') {
      if (url.searchParams.get('number') === 'DE000') return json(429, { code: 'rate_limited', detail: 'slow down', retryAfter: 1 }, { 'Retry-After': '1' });
      if (url.searchParams.get('number') === 'IT111') return json(503, { code: 'vies_unavailable', detail: 'Italy is down', retryAfter: 30 });
      return json(200, { valid: true, full: url.searchParams.get('number'), source: { kind: 'live', stale: false } });
    }
    if (url.pathname === '/api/v1/iban/validate') return json(200, { valid: true, iban: url.searchParams.get('iban'), sepa: true });
    if (url.pathname === '/api/v1/vat/rates/FR') return json(200, { country: 'FR', standard: 20, verifiedOn: '2026-10-24' });
    if (url.pathname === '/api/v1/vat/rates') return json(200, { category: url.searchParams.get('category'), rows: [] });
    return json(404, { code: 'not_found', detail: 'no' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, seen, base: `http://127.0.0.1:${server.address().port}/api/v1` };
}

/** Spawns the server over stdio and returns a request() that resolves the answer with the same id. */
function client(env) {
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let next = 1;
  return {
    request: (method, params) =>
      new Promise((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    notify: (method) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    close: () => proc.kill(),
  };
}

test('initialize, tools/list, tools/call over stdio against a fake API, with the limit states as error results', async () => {
  const api = await fakeApi();
  const c = client({ VERIPORT_API_BASE: api.base, VERIPORT_API_KEY: 'vp_live_test' });
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'veriport');
    assert.ok(init.result.capabilities.tools);
    c.notify('notifications/initialized');
    const list = await c.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['validate_vat', 'validate_iban', 'vat_rate']);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

    const vat = await c.request('tools/call', { name: 'validate_vat', arguments: { number: 'DE136695976' } });
    assert.equal(vat.result.isError, undefined);
    assert.equal(vat.result.structuredContent.valid, true);
    assert.ok(vat.result.content[0].text.includes('"kind": "live"'));
    assert.equal(api.seen[0].auth, 'Bearer vp_live_test');
    assert.ok(api.seen[0].url.startsWith('/api/v1/vat/validate?number=DE136695976'));

    const iban = await c.request('tools/call', { name: 'validate_iban', arguments: { iban: 'DE89 3704 0044 0532 0130 00' } });
    assert.equal(iban.result.structuredContent.sepa, true);
    const fr = await c.request('tools/call', { name: 'vat_rate', arguments: { country: 'fr' } });
    assert.equal(fr.result.structuredContent.standard, 20);
    const cat = await c.request('tools/call', { name: 'vat_rate', arguments: { category: 'ebooks' } });
    assert.equal(cat.result.structuredContent.category, 'ebooks');

    const limited = await c.request('tools/call', { name: 'validate_vat', arguments: { number: 'DE000' } });
    assert.equal(limited.result.isError, true);
    assert.match(limited.result.content[0].text, /rate_limited.*Retry in 1 s/);
    const down = await c.request('tools/call', { name: 'validate_vat', arguments: { number: 'IT111' } });
    assert.match(down.result.content[0].text, /vies_unavailable.*retry in 30 s/);
    const missing = await c.request('tools/call', { name: 'validate_vat', arguments: {} });
    assert.equal(missing.result.isError, true);
    const unknown = await c.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.result.isError, true);
    const bad = await c.request('no/such', {});
    assert.equal(bad.error.code, -32601);
    const ping = await c.request('ping', {});
    assert.deepEqual(ping.result, {});
  } finally {
    c.close();
    api.server.close();
  }
});
