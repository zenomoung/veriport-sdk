import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IBAN_REGISTRY, VAT_FORMATS, checkIban, checkVat, checkVatStructure, ibanCheckDigits, ibanMod97, normaliseVat, validateIbanOffline } from '../src/offline.js';

describe('VAT structure (offline)', () => {
  it('accepts every example of the generated table and splits the prefix', () => {
    for (const f of Object.values(VAT_FORMATS)) {
      const r = checkVatStructure(f.example);
      assert.equal(r.valid, true, `${f.country} ${f.example}: ${r.reason}`);
      assert.equal(r.countryCode, f.country);
      assert.equal(r.full, f.example);
    }
  });
  it('normalises separators, case, GR → EL and a separate country argument', () => {
    assert.deepEqual(normaliseVat('de 136.695-976'), { countryCode: 'DE', vatNumber: '136695976' });
    assert.deepEqual(normaliseVat('GR094259216'), { countryCode: 'EL', vatNumber: '094259216' });
    assert.deepEqual(normaliseVat('136695976', 'de'), { countryCode: 'DE', vatNumber: '136695976' });
    assert.equal(checkVatStructure('DE12345').reason, 'pattern');
    assert.equal(checkVatStructure('XX123').reason, 'country_unknown');
    assert.equal(checkVatStructure('').reason, 'empty');
  });
  it('checkVat never calls the API for an impossible number, and calls it once for a plausible one', async () => {
    let calls = 0;
    const client = { validateVat: async (p: unknown) => { calls++; return { valid: true, echo: p }; } } as never;
    const bad = await checkVat('DE12', { client });
    assert.equal(bad.kind, 'structure_only');
    assert.equal(calls, 0);
    const good = await checkVat('DE136695976', { client, requester: 'FR40303265045' });
    assert.equal(good.kind, 'api');
    assert.equal(calls, 1);
    assert.deepEqual((good.answer as unknown as { echo: unknown }).echo, { country: 'DE', number: '136695976', requester: 'FR40303265045' });
  });
});

describe('IBAN (offline)', () => {
  it('validates the documented examples and reads the identifiers', () => {
    const de = validateIbanOffline('DE89 3704 0044 0532 0130 00');
    assert.equal(de.valid, true);
    assert.equal(de.bankIdentifier, '37040044');
    assert.equal(de.sepa, true);
    const gb = validateIbanOffline('GB29 NWBK 6016 1331 9268 19');
    assert.equal(gb.valid, true);
    assert.equal(gb.bankIdentifier, 'NWBK');
    assert.equal(gb.branchIdentifier, '601613');
    const fr = validateIbanOffline('FR14 2004 1010 0505 0001 3M02 606');
    assert.equal(fr.valid, true);
  });
  it('names the rule that failed', () => {
    assert.deepEqual(validateIbanOffline('DE89 3704 0044 0532 0130 01').failures, ['check_digits']);
    assert.deepEqual(validateIbanOffline('DE89 3704 0044 0532 0130').failures, ['length', 'check_digits', 'bban_pattern']);
    assert.deepEqual(validateIbanOffline('ZZ89 3704').failures, ['country_unknown']);
    assert.deepEqual(validateIbanOffline('DE89 3704 0044 0532 0130 0!').failures, ['characters']);
    assert.deepEqual(validateIbanOffline('').failures, ['empty']);
  });
  it('mod-97 and check digits agree with the standard for every registry entry', () => {
    for (const c of Object.values(IBAN_REGISTRY)) {
      const bban = '1'.repeat(c.length - 4);
      const iban = `${c.code}${ibanCheckDigits(c.code, bban)}${bban}`;
      assert.equal(ibanMod97(iban), 1, c.code);
    }
    assert.ok(Object.keys(IBAN_REGISTRY).length >= 80);
  });
  it('checkIban skips the API for a malformed IBAN', async () => {
    let calls = 0;
    const client = { validateIban: async () => { calls++; return { valid: true }; } } as never;
    assert.equal((await checkIban('DE00', { client })).kind, 'offline');
    assert.equal(calls, 0);
    assert.equal((await checkIban('DE89370400440532013000', { client })).kind, 'api');
    assert.equal(calls, 1);
  });
});
