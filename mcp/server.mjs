#!/usr/bin/env node
/**
 * Veriport MCP server (stdio): three tools over the public API, no
 * dependency, Node 18+. Speaks the Model Context Protocol over newline-
 * delimited JSON-RPC on stdin/stdout (initialize, tools/list, tools/call,
 * ping). The API key is optional: without it the API answers a small daily
 * allowance per address.
 *
 *   VERIPORT_API_KEY   vp_live_… (optional)
 *   VERIPORT_API_BASE  defaults to https://veriport.io/api/v1
 */
import { createInterface } from 'node:readline';

const API_BASE = (process.env.VERIPORT_API_BASE ?? 'https://veriport.io/api/v1').replace(/\/$/, '');
const API_KEY = process.env.VERIPORT_API_KEY ?? '';
const PROTOCOL_VERSION = '2025-06-18';
const SERVER = { name: 'veriport', version: '0.1.0', title: 'Veriport: EU VAT number, IBAN and VAT rates checks' };

export const TOOLS = [
  {
    name: 'validate_vat',
    title: 'Validate an EU VAT number on VIES',
    description: 'Checks the structure and the national check digit, then asks the European Commission’s VIES whether the number is registered for intra-EU trade. Returns valid, the registered name and address where published, the date, and the provenance (source.kind: live, cache or structure_only; source.stale true when the member state did not answer and a dated cached answer was served). With requester (your own VAT number) and a paid key, returns the VIES consultation number. Greece is EL, Northern Ireland XI; GB is not in VIES.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'The VAT number, with or without the two-letter prefix, spaces or dots allowed (e.g. "DE136695976").' },
        country: { type: 'string', description: 'Two-letter member-state code when the number has no prefix.' },
        requester: { type: 'string', description: 'Your own EU VAT number, to obtain a VIES consultation number (paid tiers).' },
      },
      required: ['number'],
    },
    call: (a) => get('/vat/validate', { number: a.number, country: a.country, requester: a.requester }),
  },
  {
    name: 'validate_iban',
    title: 'Validate an IBAN',
    description: 'Checks an IBAN the way a payment system does: characters, country, the length the ISO 13616 registry sets, the mod 97-10 check digits, the national BBAN structure. Returns the five checks, the failed rules, the bank and branch identifiers where the registry defines them, and whether the country is in the SEPA schemes. It does not say whether the account exists or who owns it.',
    inputSchema: { type: 'object', properties: { iban: { type: 'string', description: 'The IBAN, spaces allowed.' } }, required: ['iban'] },
    call: (a) => get('/iban/validate', { iban: a.iban }),
  },
  {
    name: 'vat_rate',
    title: 'EU VAT rates of a member state',
    description: 'The standard, reduced, super-reduced and parking VAT rates of one EU member state, the rate for seven usual categories (digital services, e-books, printed books, foodstuffs, hotel accommodation, restaurant, newspapers), the day the row was verified and the official sources it was read from. Without a country, the rate of one category across the 27 states.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Two-letter member-state code (Greece is EL). Omit to get every state.' },
        category: { type: 'string', enum: ['digital_services', 'ebooks', 'printed_books', 'foodstuffs', 'hotel_accommodation', 'restaurant', 'newspapers'], description: 'With no country: one category for every member state.' },
      },
    },
    call: (a) => (a.country ? get(`/vat/rates/${encodeURIComponent(String(a.country).toUpperCase())}`, {}) : get('/vat/rates', { category: a.category })),
  },
];

async function get(path, params) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json', 'User-Agent': `veriport-mcp/${SERVER.version}` };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { detail: text };
  }
  return { ok: res.ok, status: res.status, body, retryAfter: res.headers.get('Retry-After'), quotaRemaining: res.headers.get('X-Quota-Remaining') };
}

/** One tool call to a tool result: the API's answer as text and structured content; a problem document is an error result, never an exception. */
export async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  for (const req of tool.inputSchema.required ?? []) if (args[req] === undefined || args[req] === '') return { isError: true, content: [{ type: 'text', text: `Missing argument: ${req}` }] };
  let r;
  try {
    r = await tool.call(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `The request did not reach the API: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  if (!r.ok) {
    const p = r.body ?? {};
    const hint = r.status === 429 ? ` Retry in ${r.retryAfter ?? p.retryAfter ?? 1} s.` : r.status === 402 ? ' The free allowance is used; a key with credits raises it (https://veriport.io/pricing).' : r.status === 503 ? ` The upstream did not answer; retry in ${p.retryAfter ?? 30} s.` : '';
    return { isError: true, content: [{ type: 'text', text: `${p.code ?? `http_${r.status}`}: ${p.detail ?? p.title ?? 'request failed'}${hint}` }], structuredContent: typeof p === 'object' ? p : undefined };
  }
  return { content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }], structuredContent: r.body };
}

export function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: 'Three deterministic checks on the Veriport API (https://veriport.io): validate_vat asks VIES live and says where the answer came from; validate_iban runs the five IBAN checks; vat_rate returns dated, sourced EU VAT rates. Answers are evidence only if kept with their date and provenance. Not tax advice.' });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
    case 'tools/call':
      return callTool(params?.name, params?.arguments ?? {}).then(reply);
    default:
      if (id === undefined) return null; // a notification (notifications/initialized, …): nothing to answer
      return error(-32601, `Method not found: ${method}`);
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const out = await handle(msg);
    if (out) output.write(JSON.stringify(out) + '\n');
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) serve();
