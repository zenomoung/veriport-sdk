# Veriport SDKs, MCP server and OpenAPI document

Clients and tooling for the [Veriport API](https://veriport.io/docs): the EU counterparty check (VAT number on VIES with a dated cache, French company by SIREN/SIRET, IBAN), EU VAT rates dated and sourced per row, OSS return lines, US sales-tax rates, and compliant e-invoices (XRechnung, ZUGFeRD / Factur-X, Peppol BIS: create, validate against the official rules, parse). Every answer says where it came from and when, so it can be kept as the record of the check. Free tier: 100 calls a month with a key, 20 a day without one, no card.

| Folder | What | Install |
|---|---|---|
| [`sdk-ts/`](sdk-ts) | TypeScript / JavaScript client generated from the OpenAPI document; MIT offline helpers (VAT number structure for 28 formats, the full IBAN check for 88 countries). Node 18+, Deno, Bun, browsers, edge. | `npm install @veriport/sdk` |
| [`sdk-python/`](sdk-python) | Python client (httpx, sync and async, 3.9+) with the same offline helpers, generated from the same tables. | `pip install veriport` |
| [`mcp/`](mcp) | Model Context Protocol server over stdio: `validate_vat`, `validate_iban`, `vat_rate`, `validate_einvoice`, `french_company`, `peppol_participant`. No dependency. | `claude mcp add veriport -e VERIPORT_API_KEY=vp_live_… -- npx -y @veriport/mcp` |
| [`openapi.json`](openapi.json) | The OpenAPI 3.1 document (also served live at https://veriport.io/openapi.json), with the APIs.guru extensions. | any generator |
| [`postman/`](postman) | A Postman Collection v2.1 generated from the document: one folder per tag, one request per operation with its example answer, `{{apiKey}}` and `{{baseUrl}}` variables. | import into Postman |

## One call

```ts
import { Veriport } from '@veriport/sdk';
const vp = new Veriport({ apiKey: process.env.VERIPORT_KEY });
const r = await vp.validateVat({ number: 'DE136695976' });
console.log(r.valid, r.source.kind, r.source.stale, r.requestDate);
```

```python
from veriport import Veriport
vp = Veriport(api_key=os.environ.get("VERIPORT_KEY"))
r = vp.validate_vat("DE136695976")
print(r["valid"], r["source"]["kind"], r["source"]["stale"], r["requestDate"])
```

```sh
curl "https://veriport.io/api/v1/vat/validate?country=DE&number=136695976"
```

## What the answers mean

- A VAT answer carries its provenance: `source.kind` is `live`, `cache` or `structure_only`; `source.stale` is true whenever VIES did not answer during the request. A cached answer is evidence that the number was valid on `source.checkedAt`, not today. When a member state is down, https://veriport.io/vies-status shows which and for how long.
- `consultationNumber` is returned on the paid tiers when you pass your own VAT number as `requester`: the reference a tax audit accepts.
- An IBAN that passes is well formed; existence and ownership of the account are the bank's knowledge, not anyone's API.
- Rates rows carry `verifiedOn` and `sources[]`: the day each row was last read and where.
- Every non-2xx answer is an RFC 9457 problem document with a stable `code` (https://veriport.io/docs/errors); a 4xx or 5xx is never counted.

## Development

The code in this repository is generated and tested in the Veriport monorepo (`pnpm --filter @veriport/sdk generate`, `pnpm test`); issues and pull requests here are read and ported back. Versions follow the API version in the OpenAPI document; changes are listed in each package's changelog and at https://veriport.io/changelog (Atom: https://veriport.io/changelog/atom.xml).

## Licence and publisher

MIT for everything in this repository. Published by Janolab Studio LLC, Austin, Texas (https://veriport.io/about). Not affiliated with the European Commission, SWIFT, INSEE, INPI, KoSIT or OpenPeppol; not tax advice.
