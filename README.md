# Veriport SDKs and MCP server

Clients for the [Veriport API](https://veriport.io/docs): EU VAT number validation on VIES with a dated cache and provenance on every answer, EU VAT rates dated and sourced, IBAN validation from the SWIFT registry with the SEPA flag, French company data by SIREN/SIRET, and e-invoices: create XRechnung (UBL, CII), ZUGFeRD / Factur-X and Peppol BIS files, validate any of them against the official rules, or parse one into JSON or a readable PDF. Free tier: 100 calls a month with a key, 20 keyless calls a day. OpenAPI document: <https://veriport.io/openapi.json>.

| Package | Where | Install |
|---|---|---|
| `@veriport/sdk` (TypeScript, generated from the OpenAPI document, MIT offline helpers for VAT structure and IBAN mod-97) | [`sdk-ts/`](sdk-ts) | `npm install @veriport/sdk` |
| `veriport` (Python, httpx, sync and async, offline helpers) | [`sdk-python/`](sdk-python) | `pip install veriport` |
| `@veriport/mcp` (stdio MCP server: `validate_vat`, `validate_iban`, `vat_rate`, `validate_einvoice`; no dependency, Node 18+) | [`mcp/`](mcp) | `npx -y @veriport/mcp` |

Each folder has its own README with usage. A request body is limited to 4.5 MB: the SDKs and the MCP server refuse a larger one with `payload_too_large` before sending it. The generated files under `sdk-ts/src/generated` are refreshed from the Veriport monorepo; pull requests against them are welcome but will be regenerated.

## MCP client configuration

```json
{ "mcpServers": { "veriport": { "command": "npx", "args": ["-y", "@veriport/mcp"], "env": { "VERIPORT_API_KEY": "vp_live_…" } } } }
```

Publisher: Janolab Studio LLC, Austin, Texas. Support: hello@veriport.io. Licence: MIT.
