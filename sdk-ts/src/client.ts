/**
 * A thin fetch client over the routing table generated from the OpenAPI
 * document: one `call(operationId, params, body)` and a few named methods.
 * No dependency; works in Node 18+, Deno, Bun, browsers and edge runtimes
 * (the API answers CORS). Errors are the API's RFC 9457 problem documents,
 * thrown as VeriportError with the stable `code`.
 */
import { API_VERSION, DEFAULT_BASE_URL, OPERATIONS, REQUEST_MAX_BYTES, type EInvoiceEnvelope, type EInvoiceParse, type EInvoiceValidation, type InvoiceInput, type Operations, type Problem } from './generated/openapi.js';

export interface VeriportOptions {
  /** `vp_live_…`; optional: without a key the API answers a small daily allowance per address. */
  apiKey?: string;
  /** Defaults to the production API; point it at a preview or a local run. */
  baseUrl?: string;
  /** Your own fetch (tests, proxies, retries); defaults to the global one. */
  fetch?: typeof fetch;
  /** Abort a call after this many milliseconds (default 15000). */
  timeoutMs?: number;
  /** Sent as User-Agent where the runtime allows it. */
  userAgent?: string;
}

/** What the API said about the budget on the last answer (RateLimit-* and X-Quota-Remaining headers). */
export interface CallMeta {
  status: number;
  tier: string | null;
  rateLimit: number | null;
  rateRemaining: number | null;
  quotaRemaining: number | null;
  requestId: string | null;
}

export class VeriportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;
  readonly retryAfter: number | null;
  readonly meta: CallMeta;
  constructor(status: number, problem: Problem, meta: CallMeta, retryAfter: number | null) {
    super(`${problem.code ?? `http_${status}`}: ${problem.detail ?? problem.title ?? 'request failed'}`);
    this.name = 'VeriportError';
    this.status = status;
    this.code = problem.code ?? `http_${status}`;
    this.problem = problem;
    this.retryAfter = retryAfter;
    this.meta = meta;
  }
  /** True for the states worth retrying later: a rate limit, or an upstream (VIES, registry) that did not answer. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
  /** einvoice_unsupported: the first feature the writers refused (`attachments`, `currency`, `unknown_field`…). */
  get feature(): string | null {
    return this.problem.feature ?? null;
  }
  /** einvoice_unsupported: every field or value refused. */
  get unsupported(): NonNullable<Problem['unsupported']> {
    return this.problem.unsupported ?? [];
  }
  /** einvoice_invalid: the rules the invoice breaks (rule id, severity, path, message). */
  get violations(): NonNullable<Problem['violations']> {
    return this.problem.violations ?? [];
  }
}

/** A file the e-invoice endpoints return (the XML or the PDF). */
export interface EInvoiceFile {
  bytes: Uint8Array;
  contentType: string;
  filename: string | null;
  /** The `Veriport-Validation` header: `valid; profile=…; errors=0; warnings=N` (create only). */
  validation: string | null;
  /** How many values the engine added (`Veriport-Defaults`, create only). */
  defaults: number | null;
}

/** An e-invoice to validate or parse: the XML as text, or the bytes of the XML or the hybrid PDF. */
export type EInvoiceDocument = Uint8Array | ArrayBuffer | string;

const isPdf = (b: Uint8Array) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

function documentBody(file: EInvoiceDocument, contentType?: string): { body: Uint8Array | string; contentType: string } {
  if (typeof file === 'string') return { body: file, contentType: contentType ?? 'application/xml' };
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  return { body: bytes, contentType: contentType ?? (isPdf(bytes) ? 'application/pdf' : 'application/xml') };
}

type Params<K extends keyof Operations> = Operations[K]['params'];
type Body<K extends keyof Operations> = Operations[K]['body'];
type Resp<K extends keyof Operations> = Operations[K]['response'];

export class Veriport {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  /** The budget headers of the last answer, for dashboards and back-off. */
  last: CallMeta | null = null;

  constructor(options: VeriportOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.userAgent = options.userAgent ?? `veriport-sdk-ts/${API_VERSION}`;
    if (!this.fetchImpl) throw new Error('No fetch available: pass one in the options');
  }

  /** Any JSON operation of the OpenAPI document by its operationId, typed from the generated table. */
  async call<K extends keyof Operations>(id: K, params?: Params<K>, body?: Body<K>): Promise<Resp<K>> {
    const spec = OPERATIONS[id];
    const res = await this.send(id, params, spec.hasBody ? { body: JSON.stringify(body ?? {}), contentType: 'application/json' } : undefined);
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : null) as Resp<K>;
    } catch {
      return null as unknown as Resp<K>;
    }
  }

  /** Builds the URL from the routing table, sends the request, records the budget headers, throws the problem document of a non-2xx answer. */
  private async send<K extends keyof Operations>(id: K, params: Params<K> | undefined, payload?: { body: Uint8Array | string; contentType: string }, extraHeaders: Record<string, string> = {}, accept = 'application/json'): Promise<Response> {
    const spec = OPERATIONS[id];
    const p = (params ?? {}) as Record<string, unknown>;
    let path = spec.path;
    for (const name of spec.pathParams) {
      if (p[name] === undefined || p[name] === null) throw new Error(`${String(id)}: the path parameter "${name}" is required`);
      path = path.replace(`{${name}}`, encodeURIComponent(String(p[name])));
    }
    const url = new URL(this.baseUrl + path);
    for (const name of spec.query) if (p[name] !== undefined && p[name] !== null) url.searchParams.set(name, String(p[name]));
    const headers: Record<string, string> = { Accept: accept, ...extraHeaders };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (payload) headers['Content-Type'] = payload.contentType;
    if (typeof navigator === 'undefined') headers['User-Agent'] = this.userAgent;
    if (payload) {
      const size = typeof payload.body === 'string' ? new TextEncoder().encode(payload.body).length : payload.body.length;
      if (size > REQUEST_MAX_BYTES) throw tooLarge(size, null);
    }
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetchImpl(url, { method: spec.method, headers, body: payload?.body as BodyInit | undefined, signal: controller?.signal });
      const meta = readMeta(res);
      this.last = meta;
      if (!res.ok) {
        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        // A body over the limit is answered by the hosting platform, not the API: no problem document, so it is named here.
        if (res.status === 413 && !(json && typeof json === 'object' && 'code' in json)) throw tooLarge(null, meta);
        const problem = (json && typeof json === 'object' ? json : { title: res.statusText, status: res.status }) as Problem;
        const ra = res.headers.get('Retry-After');
        throw new VeriportError(res.status, problem, meta, ra ? Number(ra) : ((problem as { retryAfter?: number }).retryAfter ?? null));
      }
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** GET /vat/validate: structure and check digit, then VIES live or the dated cache. `number` may carry the prefix (`DE136695976`). */
  validateVat(params: Params<'validateVatNumber'>) {
    return this.call('validateVatNumber', params);
  }

  /** POST /vat/validate/bulk (monthly plan): one result per item, a problem document in a failed slot. */
  validateVatBulk(body: Body<'validateVatNumbersBulk'>) {
    return this.call('validateVatNumbersBulk', {} as Params<'validateVatNumbersBulk'>, body);
  }

  /** GET /vat/rates: the 27 rows, or one category across the Union with `category`. */
  vatRates(params: Params<'listVatRates'> = {} as Params<'listVatRates'>) {
    return this.call('listVatRates', params);
  }

  /** GET /vat/rates/{country}: one member state with its verifiedOn and sources. */
  vatRate(country: string) {
    return this.call('getVatRates', { country } as Params<'getVatRates'>);
  }

  /** GET /iban/validate: the five checks, bank and branch identifiers, SEPA flag. Spaces allowed. */
  validateIban(iban: string) {
    return this.call('validateIban', { iban } as Params<'validateIban'>);
  }

  /** POST /iban/validate/bulk (monthly plan). */
  validateIbanBulk(body: Body<'validateIbansBulk'>) {
    return this.call('validateIbansBulk', {} as Params<'validateIbansBulk'>, body);
  }

  /** GET /fr/company/{id}: SIREN, SIRET or French VAT number to the registry record. */
  frCompany(id: string) {
    return this.call('getFrenchCompany', { id } as Params<'getFrenchCompany'>);
  }

  /** GET /us/sales-tax?zip=. */
  usSalesTax(zip: string) {
    return this.call('getUsSalesTax', { zip } as Params<'getUsSalesTax'>);
  }

  /**
   * POST /einvoice/create (key required, 20 calls): the invoice JSON → the e-invoice file (XRechnung UBL or CII
   * XML, the ZUGFeRD / Factur-X PDF, or Peppol BIS XML, per `invoice.format`). With `envelope: true` the typed
   * envelope { file (base64), contentType, validation, defaults }. Send an `idempotencyKey` so a retry replays
   * the same file without a second charge. Refusals throw VeriportError: `einvoice_unsupported` (`feature`,
   * `unsupported`) or `einvoice_invalid` (`violations`).
   */
  createEInvoice(invoice: InvoiceInput, options: { envelope: true; idempotencyKey?: string }): Promise<EInvoiceEnvelope>;
  createEInvoice(invoice: InvoiceInput, options?: { envelope?: false; idempotencyKey?: string }): Promise<EInvoiceFile>;
  async createEInvoice(invoice: InvoiceInput, options: { envelope?: boolean; idempotencyKey?: string } = {}): Promise<EInvoiceFile | EInvoiceEnvelope> {
    const headers: Record<string, string> = options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {};
    const params = (options.envelope ? { envelope: 'json' } : {}) as Params<'createEInvoice'>;
    const res = await this.send('createEInvoice', params, { body: JSON.stringify(invoice), contentType: 'application/json' }, headers, options.envelope ? 'application/json' : 'application/xml, application/pdf, application/problem+json');
    if (options.envelope) return (await res.json()) as EInvoiceEnvelope;
    return fileOf(res);
  }

  /** POST /einvoice/validate (5 calls; works without a key on the daily allowance): the schema and the official CEN, XRechnung or Peppol rules on an XML or a hybrid PDF. */
  async validateEInvoice(file: EInvoiceDocument, options: { contentType?: string } = {}): Promise<EInvoiceValidation> {
    const res = await this.send('validateEInvoice', {} as Params<'validateEInvoice'>, documentBody(file, options.contentType));
    return (await res.json()) as EInvoiceValidation;
  }

  /** POST /einvoice/parse (key required, 5 calls): the invoice JSON of a received e-invoice and what it leaves out; `as: 'pdf'` returns a readable PDF copy. */
  parseEInvoice(file: EInvoiceDocument, options: { as: 'pdf'; lang?: 'de' | 'en' | 'fr' | 'nl'; contentType?: string }): Promise<EInvoiceFile>;
  parseEInvoice(file: EInvoiceDocument, options?: { as?: 'json'; contentType?: string }): Promise<EInvoiceParse>;
  async parseEInvoice(file: EInvoiceDocument, options: { as?: 'json' | 'pdf'; lang?: 'de' | 'en' | 'fr' | 'nl'; contentType?: string } = {}): Promise<EInvoiceParse | EInvoiceFile> {
    const params = (options.as === 'pdf' ? { as: 'pdf', lang: options.lang } : {}) as Params<'parseEInvoice'>;
    const res = await this.send('parseEInvoice', params, documentBody(file, options.contentType), {}, options.as === 'pdf' ? 'application/pdf, application/problem+json' : 'application/json');
    if (options.as === 'pdf') return fileOf(res);
    return (await res.json()) as EInvoiceParse;
  }

  /** GET /me: the key's tier, usage and credits (key required). */
  me() {
    return this.call('getMe');
  }

  /** GET /status: components and VIES availability per member state. */
  status() {
    return this.call('getStatus');
  }
}

async function fileOf(res: Response): Promise<EInvoiceFile> {
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
  const defaults = res.headers.get('Veriport-Defaults');
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('Content-Type') ?? 'application/octet-stream', filename: name, validation: res.headers.get('Veriport-Validation'), defaults: defaults === null ? null : Number(defaults) };
}

/** payload_too_large, raised before sending (size known) or from the platform's bare 413. */
function tooLarge(size: number | null, meta: CallMeta | null): VeriportError {
  const limit = `one request is limited to ${REQUEST_MAX_BYTES} bytes (4.5 MB); send the XML rather than a PDF carrying large attachments, or split the upload.`;
  const problem = { code: 'payload_too_large', status: 413, title: 'Too many rows or too many bytes', detail: size === null ? `The request was refused before it reached the API: ${limit}` : `${size} bytes; ${limit}` } as Problem;
  return new VeriportError(413, problem, meta ?? { status: 413, tier: null, rateLimit: null, rateRemaining: null, quotaRemaining: null, requestId: null }, null);
}

function readMeta(res: Response): CallMeta {
  const num = (h: string) => {
    const v = res.headers.get(h);
    return v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
  };
  return { status: res.status, tier: res.headers.get('X-Tier'), rateLimit: num('RateLimit-Limit'), rateRemaining: num('RateLimit-Remaining'), quotaRemaining: num('X-Quota-Remaining'), requestId: res.headers.get('X-Request-Id') };
}
