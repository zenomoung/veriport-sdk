/**
 * A thin fetch client over the routing table generated from the OpenAPI
 * document: one `call(operationId, params, body)` and a few named methods.
 * No dependency; works in Node 18+, Deno, Bun, browsers and edge runtimes
 * (the API answers CORS). Errors are the API's RFC 9457 problem documents,
 * thrown as VeriportError with the stable `code`.
 */
import { API_VERSION, DEFAULT_BASE_URL, OPERATIONS, type Operations, type Problem } from './generated/openapi.js';

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

  /** Any operation of the OpenAPI document by its operationId, typed from the generated table. */
  async call<K extends keyof Operations>(id: K, params?: Params<K>, body?: Body<K>): Promise<Resp<K>> {
    const spec = OPERATIONS[id];
    const p = (params ?? {}) as Record<string, unknown>;
    let path = spec.path;
    for (const name of spec.pathParams) {
      if (p[name] === undefined || p[name] === null) throw new Error(`${String(id)}: the path parameter "${name}" is required`);
      path = path.replace(`{${name}}`, encodeURIComponent(String(p[name])));
    }
    const url = new URL(this.baseUrl + path);
    for (const name of spec.query) if (p[name] !== undefined && p[name] !== null) url.searchParams.set(name, String(p[name]));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (spec.hasBody) headers['Content-Type'] = 'application/json';
    if (typeof navigator === 'undefined') headers['User-Agent'] = this.userAgent;
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetchImpl(url, { method: spec.method, headers, body: spec.hasBody ? JSON.stringify(body ?? {}) : undefined, signal: controller?.signal });
      const meta = readMeta(res);
      this.last = meta;
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const problem = (json && typeof json === 'object' ? json : { title: res.statusText, status: res.status }) as Problem;
        const ra = res.headers.get('Retry-After');
        throw new VeriportError(res.status, problem, meta, ra ? Number(ra) : ((problem as { retryAfter?: number }).retryAfter ?? null));
      }
      return json as Resp<K>;
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

  /** GET /me: the key's tier, usage and credits (key required). */
  me() {
    return this.call('getMe');
  }

  /** GET /status: components and VIES availability per member state. */
  status() {
    return this.call('getStatus');
  }
}

function readMeta(res: Response): CallMeta {
  const num = (h: string) => {
    const v = res.headers.get(h);
    return v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
  };
  return { status: res.status, tier: res.headers.get('X-Tier'), rateLimit: num('RateLimit-Limit'), rateRemaining: num('RateLimit-Remaining'), quotaRemaining: num('X-Quota-Remaining'), requestId: res.headers.get('X-Request-Id') };
}
