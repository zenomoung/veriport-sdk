import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Veriport, VeriportError } from '../src/client.js';
import { REQUEST_MAX_BYTES, type InvoiceInput } from '../src/generated/openapi.js';

type Reply = { status: number; body: BodyInit | null; headers?: Record<string, string> };
function fakeFetch(handler: (url: URL, init: RequestInit) => Reply) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const f = (async (input: URL | string | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const h = (init: RequestInit) => init.headers as Record<string, string>;
const INVOICE = { format: 'xrechnung-ubl', number: '2026-017', issueDate: '2026-10-20' } as unknown as InvoiceInput;
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<ubl:Invoice/>';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

describe('e-invoice methods', () => {
  it('createEInvoice posts the JSON, sends the Idempotency-Key, returns the file with its validation header', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: XML, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="xrechnung-ubl-2026-017.xml"', 'Veriport-Validation': 'valid; profile=xrechnung; errors=0; warnings=0', 'Veriport-Defaults': '2', 'X-Tier': 'credits' } }));
    const vp = new Veriport({ apiKey: 'vp_live_test', fetch: f });
    const file = await vp.createEInvoice(INVOICE, { idempotencyKey: 'inv-2026-017' });
    assert.equal(calls[0].url.toString(), 'https://veriport.io/api/v1/einvoice/create');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(h(calls[0].init)['Content-Type'], 'application/json');
    assert.equal(h(calls[0].init)['Idempotency-Key'], 'inv-2026-017');
    assert.equal(h(calls[0].init).Authorization, 'Bearer vp_live_test');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), INVOICE);
    assert.equal(new TextDecoder().decode(file.bytes), XML);
    assert.deepEqual([file.contentType, file.filename, file.validation, file.defaults], ['application/xml; charset=utf-8', 'xrechnung-ubl-2026-017.xml', 'valid; profile=xrechnung; errors=0; warnings=0', 2]);
    assert.equal(vp.last?.tier, 'credits');
  });
  it('createEInvoice with envelope: true asks for ?envelope=json and returns the typed envelope', async () => {
    const envelope = { format: 'zugferd', filename: 'zugferd-1.pdf', contentType: 'application/pdf', size: 8, file: 'JVBERi0xLjc=', validation: { valid: true, profile: 'en16931', syntax: 'cii', errors: [], warnings: [], checks: {} }, defaults: [] };
    const { f, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify(envelope), headers: { 'Content-Type': 'application/json' } }));
    const r = await new Veriport({ apiKey: 'vp_live_test', fetch: f }).createEInvoice(INVOICE, { envelope: true });
    assert.equal(calls[0].url.search, '?envelope=json');
    assert.equal(r.validation.valid, true);
    assert.equal(r.file, 'JVBERi0xLjc=');
  });
  it('a refusal throws VeriportError with code, feature, unsupported and violations', async () => {
    const unsupported = { type: 'https://veriport.io/docs/errors#einvoice_unsupported', title: 't', status: 422, detail: 'd', instance: 'req_1', code: 'einvoice_unsupported', feature: 'attachments', path: 'attachments', unsupported: [{ feature: 'attachments', path: 'attachments', detail: 'x' }] };
    const invalid = { type: 'https://veriport.io/docs/errors#einvoice_invalid', title: 't', status: 422, detail: 'd', instance: 'req_2', code: 'einvoice_invalid', violations: [{ rule: 'BR-DE-15', severity: 'fatal', path: 'buyerReference', message: 'm' }] };
    let n = 0;
    const { f } = fakeFetch(() => ({ status: 422, body: JSON.stringify(n++ === 0 ? unsupported : invalid), headers: { 'Content-Type': 'application/problem+json' } }));
    const vp = new Veriport({ apiKey: 'vp_live_test', fetch: f });
    await assert.rejects(vp.createEInvoice(INVOICE), (e: unknown) => e instanceof VeriportError && e.code === 'einvoice_unsupported' && e.feature === 'attachments' && e.unsupported.length === 1 && e.status === 422);
    await assert.rejects(vp.createEInvoice(INVOICE), (e: unknown) => e instanceof VeriportError && e.code === 'einvoice_invalid' && e.feature === null && e.violations[0].rule === 'BR-DE-15');
  });
  it('validateEInvoice sends XML text as application/xml and PDF bytes as application/pdf, without a key if none is set', async () => {
    const report = { valid: false, profile: 'peppol-bis', syntax: 'ubl', errors: [{ rule: 'PEPPOL-COMMON-R043', severity: 'fatal', path: '/Invoice', message: 'm' }], warnings: [], checks: {} };
    const { f, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify(report), headers: { 'Content-Type': 'application/json', 'X-Tier': 'anonymous' } }));
    const vp = new Veriport({ fetch: f });
    const r = await vp.validateEInvoice(XML);
    assert.equal(calls[0].url.pathname, '/api/v1/einvoice/validate');
    assert.equal(h(calls[0].init)['Content-Type'], 'application/xml');
    assert.equal(h(calls[0].init).Authorization, undefined);
    assert.equal(calls[0].init.body, XML);
    assert.equal(r.errors[0].rule, 'PEPPOL-COMMON-R043');
    await vp.validateEInvoice(PDF);
    assert.equal(h(calls[1].init)['Content-Type'], 'application/pdf');
    assert.deepEqual(calls[1].init.body, PDF);
    await vp.validateEInvoice(new TextEncoder().encode(XML));
    assert.equal(h(calls[2].init)['Content-Type'], 'application/xml');
  });
  it('parseEInvoice returns the JSON, or with as: pdf the readable copy with ?as=pdf&lang=', async () => {
    const parsed = { invoice: INVOICE, format: 'xrechnung-ubl', profile: 'xrechnung', syntax: 'ubl', container: 'xml', notInJson: [] };
    const { f, calls } = fakeFetch((url): Reply => (url.searchParams.get('as') === 'pdf' ? { status: 200, body: PDF, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="readable-copy-2026-017.pdf"' } } : { status: 200, body: JSON.stringify(parsed), headers: { 'Content-Type': 'application/json' } }));
    const vp = new Veriport({ apiKey: 'vp_live_test', fetch: f });
    const j = await vp.parseEInvoice(XML);
    assert.equal(calls[0].url.toString(), 'https://veriport.io/api/v1/einvoice/parse');
    assert.equal(j.invoice.number, '2026-017');
    assert.deepEqual(j.notInJson, []);
    const pdf = await vp.parseEInvoice(XML, { as: 'pdf', lang: 'de' });
    assert.equal(calls[1].url.search, '?as=pdf&lang=de');
    assert.deepEqual(pdf.bytes, PDF);
    assert.equal(pdf.filename, 'readable-copy-2026-017.pdf');
  });
  it('a body over REQUEST_MAX_BYTES is refused as payload_too_large before anything is sent', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: '{}' }));
    const vp = new Veriport({ fetch: f });
    const big = new Uint8Array(REQUEST_MAX_BYTES + 1);
    await assert.rejects(vp.validateEInvoice(big), (e: unknown) => e instanceof VeriportError && e.status === 413 && e.code === 'payload_too_large' && e.message.includes(String(REQUEST_MAX_BYTES + 1)));
    assert.equal(calls.length, 0);
    await vp.validateEInvoice(new Uint8Array(REQUEST_MAX_BYTES));
    assert.equal(calls.length, 1);
  });
  it('the hosting platform’s bare 413 (no problem document) becomes payload_too_large', async () => {
    const { f } = fakeFetch(() => ({ status: 413, body: 'Request Entity Too Large', headers: { 'Content-Type': 'text/plain', 'X-Vercel-Error': 'FUNCTION_PAYLOAD_TOO_LARGE' } }));
    await assert.rejects(new Veriport({ fetch: f }).validateEInvoice(XML), (e: unknown) => e instanceof VeriportError && e.code === 'payload_too_large' && e.status === 413);
  });
});

