# @veriport/sdk

TypeScript client for the [Veriport API](https://veriport.io/docs): EU VAT number validation on VIES with a dated cache, EU VAT rates dated and sourced per row, IBAN validation from the SWIFT registry, French company data by SIREN/SIRET, and compliant e-invoices (XRechnung, ZUGFeRD / Factur-X, Peppol BIS: create, validate against the official rules, parse). Generated from the API's [OpenAPI document](https://veriport.io/openapi.json), no runtime dependency, works in Node 18+, Deno, Bun, browsers and edge runtimes.

It also ships the **offline** parts of the checks under the MIT licence, so that an impossible VAT number or a malformed IBAN never costs a call:

- `checkVatStructure()` — the published structure of each of the 28 EU VAT number formats (no network, no check digit: registration is VIES's answer);
- `validateIbanOffline()` — the full IBAN check: characters, country, length, ISO 7064 mod 97-10, BBAN pattern, bank and branch identifiers, SEPA flag, for the 88 countries of the registry.

```sh
npm install @veriport/sdk
```

## One call

```ts
import { Veriport } from '@veriport/sdk';

const vp = new Veriport({ apiKey: process.env.VERIPORT_KEY }); // the key is optional for the first 20 calls a day

const r = await vp.validateVat({ number: 'DE136695976' });
console.log(r.valid, r.source.kind, r.source.stale); // true "live" false

const iban = await vp.validateIban('DE89 3704 0044 0532 0130 00');
console.log(iban.valid, iban.bankIdentifier, iban.sepa);

const fr = await vp.vatRate('FR');
console.log(fr.standard, fr.verifiedOn, fr.sources);

const company = await vp.frCompany('356000000');
console.log(company.name, company.status, company.source.primary);
```

Every operation of the document is reachable by its `operationId` with the generated types:

```ts
const rows = await vp.call('listVatRates', { category: 'ebooks' });
```

## E-invoices

```ts
import { readFile, writeFile } from 'node:fs/promises';

// invoice JSON → XRechnung, ZUGFeRD / Factur-X PDF or Peppol BIS (20 calls; a retry with the same key is not charged twice)
const file = await vp.createEInvoice({ format: 'xrechnung-ubl', ...invoice }, { idempotencyKey: invoice.number });
await writeFile(file.filename ?? 'invoice.xml', file.bytes);
console.log(file.validation); // "valid; profile=xrechnung; errors=0; warnings=0"

// any e-invoice (XML text or the bytes of a hybrid PDF) → the official verdict (5 calls; works without a key)
const report = await vp.validateEInvoice(await readFile('received.pdf'));
for (const e of report.errors) console.log(e.rule, e.path, e.message);

// a received e-invoice → the same invoice JSON, plus what the JSON leaves out; { as: 'pdf' } gives a readable copy
const parsed = await vp.parseEInvoice(await readFile('received.xml', 'utf8'));
console.log(parsed.invoice.number, parsed.notInJson);
```

A refusal throws `VeriportError`: `e.code === 'einvoice_unsupported'` with `e.feature` and `e.unsupported` (a field the writers do not produce is refused, never dropped), or `'einvoice_invalid'` with `e.violations` (the rule ids and JSON paths).

## Offline first, API second

```ts
import { Veriport, checkVat, checkIban } from '@veriport/sdk';

const vp = new Veriport({ apiKey: process.env.VERIPORT_KEY });

const vat = await checkVat('DE 136 695 976', { client: vp, requester: 'FR40303265045' });
// vat.kind === 'structure_only' when the string cannot be a VAT number (no call made)
// vat.kind === 'api' with vat.answer (valid, name, consultationNumber, source) otherwise

const iban = await checkIban('DE89 3704 0044 0532 0130 00', { client: vp });
// iban.offline is the full local check; iban.answer the API's answer with the registry date
```

Without a client, both helpers are pure functions:

```ts
import { checkVatStructure, validateIbanOffline, ibanMod97 } from '@veriport/sdk/offline';

checkVatStructure('FR40303265045'); // { valid: true, countryCode: 'FR', vatNumber: '40303265045', expected: '2 characters … + 9 digits (SIREN)' }
validateIbanOffline('GB29 NWBK 6016 1331 9268 19'); // { valid: true, bankIdentifier: 'NWBK', branchIdentifier: '601613', sepa: true, … }
```

## Errors

Every non-2xx answer is an RFC 9457 problem document, thrown as `VeriportError`:

```ts
import { VeriportError } from '@veriport/sdk';

try {
  await vp.validateVat({ number: 'IT00743110157' });
} catch (e) {
  if (e instanceof VeriportError && e.code === 'vies_unavailable') {
    // the member state did not answer and no cached answer exists: retry in e.retryAfter seconds
  }
  if (e instanceof VeriportError && e.code === 'quota_exceeded') {
    // buy a pack or wait for the month: https://veriport.io/pricing
  }
}
```

`vp.last` holds the budget headers of the last answer (`RateLimit-Limit`, `RateLimit-Remaining`, `X-Quota-Remaining`, `X-Tier`).

## What the answers mean

- A VAT answer carries its provenance: `source.kind` is `live`, `cache` or `structure_only`; `source.stale` is true whenever VIES did not answer during the request. A cached answer is evidence that the number was valid on `source.checkedAt`, not today.
- `consultationNumber` is returned on the paid tiers when you pass your own VAT number as `requester`: it is the reference a tax audit accepts.
- An IBAN that passes is well formed; existence and ownership of the account are the bank's knowledge, not anyone's API.
- Rates rows carry `verifiedOn` and `sources[]`: the day each row was last read and where.

## Development

```sh
pnpm generate          # regenerate src/generated from the shared OpenAPI document (and the Python tables)
pnpm generate --check  # fail when the committed files are stale (prepublishOnly runs it)
pnpm test
pnpm build
```

MIT. Published by Janolab Studio LLC, Austin, Texas. Not affiliated with the European Commission, SWIFT, INSEE or INPI; not tax advice.
