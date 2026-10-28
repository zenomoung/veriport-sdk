/**
 * The offline parts of the two checks, MIT, no network: the structure of an
 * EU VAT number (the Commission's published structures, no check digit: that
 * and the registration itself are VIES's and the API's job) and the full IBAN
 * check (characters, country, length, ISO 7064 mod 97-10, BBAN pattern from
 * the SWIFT registry, bank and branch identifiers, SEPA flag). Both read the
 * generated tables, which the API uses too.
 *
 * `checkVat()` chains the two: structure here, VIES through the client only
 * when the structure passes, so an impossible number never costs a call.
 */
import type { Veriport } from './client.js';
import type { Operations } from './generated/openapi.js';
import { IBAN_REGISTRY, type IbanCountry } from './generated/iban-registry.js';
import { VAT_FORMATS, type VatFormat } from './generated/vat-formats.js';

export { IBAN_REGISTRY, VAT_FORMATS };
export type { IbanCountry, VatFormat };

/* ------------------------------------------------------------ VAT numbers */

export interface VatStructure {
  /** The input can be a VAT number of that member state (structure only; registration is VIES's answer). */
  valid: boolean;
  countryCode: string | null;
  /** The number after the prefix, upper case, separators removed. */
  vatNumber: string | null;
  /** Prefix + number, the form the API and VIES expect. */
  full: string | null;
  /** The published structure, in words, when the country is known. */
  expected: string | null;
  reason: 'empty' | 'country_unknown' | 'pattern' | null;
}

/** Splits an input such as "DE 136 695 976", "de136695976" or ("DE", "136695976"); GR becomes EL; a repeated prefix is removed. */
export function normaliseVat(input: string, country?: string): { countryCode: string | null; vatNumber: string } {
  let s = (input ?? '').toUpperCase().replace(/[\s.\-_/]/g, '');
  let cc = (country ?? '').toUpperCase().replace(/[^A-Z]/g, '') || null;
  if (cc === 'GR') cc = 'EL';
  const m = s.match(/^([A-Z]{2})(.*)$/);
  if (m && (VAT_FORMATS[m[1]] || m[1] === 'GR')) {
    const prefix = m[1] === 'GR' ? 'EL' : m[1];
    if (!cc || cc === prefix) {
      cc = prefix;
      s = m[2];
    }
  }
  return { countryCode: cc, vatNumber: s };
}

/** The structural check: true means the string has the shape of a VAT number of that state, nothing more. */
export function checkVatStructure(input: string, country?: string): VatStructure {
  const { countryCode, vatNumber } = normaliseVat(input, country);
  if (!vatNumber && !countryCode) return { valid: false, countryCode: null, vatNumber: null, full: null, expected: null, reason: 'empty' };
  const f = countryCode ? VAT_FORMATS[countryCode] : undefined;
  if (!f) return { valid: false, countryCode, vatNumber: vatNumber || null, full: null, expected: null, reason: 'country_unknown' };
  const ok = new RegExp(f.pattern).test(vatNumber);
  return { valid: ok, countryCode: f.country, vatNumber, full: `${f.country}${vatNumber}`, expected: f.structure, reason: ok ? null : 'pattern' };
}

export type VatCheck = { kind: 'structure_only'; structure: VatStructure; answer: null } | { kind: 'api'; structure: VatStructure; answer: Operations['validateVatNumber']['response'] };

/**
 * Structure first, then the API only when the structure passes and a client
 * is given: an impossible number never reaches VIES and never costs a call.
 */
export async function checkVat(input: string, options: { client?: Veriport; country?: string; requester?: string } = {}): Promise<VatCheck> {
  const structure = checkVatStructure(input, options.country);
  if (!structure.valid || !options.client) return { kind: 'structure_only', structure, answer: null };
  const answer = await options.client.validateVat({ country: structure.countryCode ?? undefined, number: structure.vatNumber ?? '', requester: options.requester } as Operations['validateVatNumber']['params']);
  return { kind: 'api', structure, answer };
}

/* ------------------------------------------------------------------ IBAN */

export type IbanFailure = 'empty' | 'characters' | 'country_unknown' | 'length' | 'check_digits' | 'bban_pattern';

export interface IbanCheck {
  valid: boolean;
  /** Electronic form: upper case, no separators. */
  iban: string;
  /** Paper form, groups of four. */
  formatted: string;
  countryCode: string | null;
  countryName: string | null;
  checkDigits: string | null;
  bban: string | null;
  bankIdentifier: string | null;
  branchIdentifier: string | null;
  expectedLength: number | null;
  sepa: boolean | null;
  sepaSince: string | null;
  checks: { characters: boolean; country: boolean; length: boolean; mod97: boolean; bbanPattern: boolean };
  failures: IbanFailure[];
}

export function normaliseIban(input: string): string {
  return (input ?? '').toUpperCase().replace(/[\s\-.]/g, '');
}

export function formatIban(compact: string): string {
  return compact.replace(/(.{4})/g, '$1 ').trim();
}

/** The registry notation ("4!a6!n8!n") compiled to a regular expression over the BBAN. */
export function bbanRegex(bban: string): RegExp {
  const parts = [...bban.matchAll(/(\d+)(!?)([anc])/g)].map(([, len, fixed, kind]) => {
    const cls = kind === 'n' ? '[0-9]' : kind === 'a' ? '[A-Z]' : '[A-Z0-9]';
    return `${cls}{${fixed ? len : `1,${len}`}}`;
  });
  return new RegExp(`^${parts.join('')}$`);
}

/** ISO 7064 mod 97-10 remainder of an IBAN (letters A–Z → 10–35, the first four characters moved to the end); valid when 1. */
export function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let r = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}

/** The two check digits for a country and a BBAN (to build test IBANs, or to explain the rule). */
export function ibanCheckDigits(country: string, bban: string): string {
  return String(98 - ibanMod97(`${country}00${bban}`)).padStart(2, '0');
}

/** The full offline IBAN check, the same five rules as GET /iban/validate. */
export function validateIbanOffline(input: string): IbanCheck {
  const iban = normaliseIban(input);
  const base: IbanCheck = { valid: false, iban, formatted: formatIban(iban), countryCode: null, countryName: null, checkDigits: null, bban: null, bankIdentifier: null, branchIdentifier: null, expectedLength: null, sepa: null, sepaSince: null, checks: { characters: false, country: false, length: false, mod97: false, bbanPattern: false }, failures: [] };
  if (!iban) return { ...base, failures: ['empty'] };
  if (!/^[A-Z0-9]+$/.test(iban)) return { ...base, failures: ['characters'] };
  base.checks.characters = true;
  const code = iban.slice(0, 2);
  const country = IBAN_REGISTRY[code];
  if (!/^[A-Z]{2}[0-9]{2}/.test(iban) || !country) return { ...base, countryCode: /^[A-Z]{2}/.test(iban) ? code : null, failures: ['country_unknown'] };
  base.checks.country = true;
  base.countryCode = code;
  base.countryName = country.name;
  base.expectedLength = country.length;
  base.sepa = country.sepa;
  base.sepaSince = country.sepaSince ?? null;
  base.checkDigits = iban.slice(2, 4);
  const failures: IbanFailure[] = [];
  if (iban.length !== country.length) failures.push('length');
  else base.checks.length = true;
  if (ibanMod97(iban) === 1) base.checks.mod97 = true;
  else failures.push('check_digits');
  const bban = iban.slice(4);
  base.bban = bban;
  if (bbanRegex(country.bban).test(bban)) base.checks.bbanPattern = true;
  else failures.push('bban_pattern');
  if (country.bankId && base.checks.length) base.bankIdentifier = bban.slice(country.bankId[0], country.bankId[0] + country.bankId[1]);
  if (country.branchId && base.checks.length) base.branchIdentifier = bban.slice(country.branchId[0], country.branchId[0] + country.branchId[1]);
  base.failures = failures;
  base.valid = failures.length === 0;
  return base;
}

/**
 * Offline first, then the API only when a client is given and the offline
 * check passed (the API's answer adds the registry date and is kept as the
 * record of the check); a malformed IBAN never costs a call.
 */
export async function checkIban(input: string, options: { client?: Veriport } = {}): Promise<{ kind: 'offline'; offline: IbanCheck; answer: null } | { kind: 'api'; offline: IbanCheck; answer: Operations['validateIban']['response'] }> {
  const offline = validateIbanOffline(input);
  if (!offline.valid || !options.client) return { kind: 'offline', offline, answer: null };
  return { kind: 'api', offline, answer: await options.client.validateIban(offline.iban) };
}
