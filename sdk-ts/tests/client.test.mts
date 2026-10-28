import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Veriport, VeriportError } from '../src/client.js';
import { OPERATIONS } from '../src/generated/openapi.js';

function fakeFetch(handler: (url: URL, init: RequestInit) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const f = (async (input: URL | string | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('client', () => {
  it('builds the URL from the routing table, sends the key, reads the budget headers', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { valid: true }, headers: { 'RateLimit-Limit': '2', 'RateLimit-Remaining': '1', 'X-Quota-Remaining': '99', 'X-Tier': 'free' } }));
    const vp = new Veriport({ apiKey: 'vp_live_test', fetch: f });
    const r = await vp.validateVat({ country: 'DE', number: '136695976' });
    assert.deepEqual(r, { valid: true });
    assert.equal(calls[0].url.toString(), 'https://veriport.io/api/v1/vat/validate?country=DE&number=136695976');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer vp_live_test');
    assert.deepEqual(vp.last, { status: 200, tier: 'free', rateLimit: 2, rateRemaining: 1, quotaRemaining: 99, requestId: null });
  });
  it('encodes path parameters and sends a JSON body for POST operations', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const vp = new Veriport({ fetch: f, baseUrl: 'http://localhost:3074/api/v1/' });
    await vp.frCompany('356 000 000');
    assert.equal(calls[0].url.pathname, '/api/v1/fr/company/356%20000%20000');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, undefined);
    await vp.validateIbanBulk({ ibans: ['DE89370400440532013000'] });
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].init.body, '{"ibans":["DE89370400440532013000"]}');
    await vp.vatRate('fr');
    assert.equal(calls[2].url.pathname, '/api/v1/vat/rates/fr');
  });
  it('throws the problem document with its stable code and retryAfter', async () => {
    const { f } = fakeFetch(() => ({ status: 503, body: { type: 'https://veriport.io/docs/errors#vies_unavailable', title: 'VIES did not answer', status: 503, code: 'vies_unavailable', detail: 'retry', retryAfter: 30 }, headers: { 'Retry-After': '30' } }));
    const vp = new Veriport({ fetch: f });
    await assert.rejects(vp.validateVat({ number: 'DE136695976' }), (e: unknown) => {
      assert.ok(e instanceof VeriportError);
      assert.equal(e.code, 'vies_unavailable');
      assert.equal(e.status, 503);
      assert.equal(e.retryAfter, 30);
      assert.equal(e.retryable, true);
      return true;
    });
  });
  it('the routing table covers every operation with a method, a path and the anonymous flag', () => {
    const ids = Object.keys(OPERATIONS);
    assert.ok(ids.includes('validateVatNumber') && ids.includes('validateIban') && ids.includes('getVatRates') && ids.includes('getFrenchCompany'));
    for (const spec of Object.values(OPERATIONS)) {
      assert.ok(spec.method === 'GET' || spec.method === 'POST');
      assert.ok(spec.path.startsWith('/'));
      for (const pp of spec.pathParams) assert.ok(spec.path.includes(`{${pp}}`));
    }
    assert.equal(OPERATIONS.validateVatNumber.anonymous, true);
    assert.equal(OPERATIONS.getMe.anonymous, false);
  });
});
