# Veriport MCP server

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server over stdio that gives an agent four deterministic checks from the [Veriport API](https://veriport.io): no dependency, one file, Node 18+.

| Tool | What it does |
|---|---|
| `validate_vat` | Structure and national check digit, then the European Commission's VIES live; returns `valid`, the registered name and address where published, the date, and the provenance (`source.kind` live / cache / structure_only, `source.stale`); the VIES consultation number with `requester` on a paid key. |
| `validate_iban` | The five IBAN checks (characters, country, length, mod 97-10, BBAN pattern), the failed rules, bank and branch identifiers, SEPA flag. Does not say whether the account exists. |
| `vat_rate` | Standard, reduced, super-reduced and parking VAT rates of one EU member state with seven category hints, `verifiedOn` and the official sources; or one category across the 27 states. |
| `validate_einvoice` | An e-invoice (`xml` as text, or a ZUGFeRD / Factur-X PDF as `pdf_base64`) against the XML schema and the official schematron of its profile (CEN EN 16931 1.3.16, XRechnung 3.0.2, Peppol BIS 3.0.21): `valid`, profile, syntax, the errors with the published rule ids and XPaths, a one-line summary first. 5 calls a check (4 a day without a key); nothing is sent on a network or stored. |
| `french_company` | A French company by SIREN (9 digits) or SIRET (14 digits) from the official registries (Recherche d'entreprises, INSEE Sirene as fallback): name, legal form, NAF activity, active or ceased with dates, head-office address, the establishment for a SIRET, the VAT number computed from the SIREN, and when the registries were read. 1 call. |
| `peppol_participant` | Can this company receive Peppol invoices? `id`: a Peppol ID (`0208:0202239951`) or a Belgian enterprise or VAT number (looked up under 0208 and 9925). Whether it is registered, which documents it receives (`receives.invoice`, `receives.creditNote` for Peppol BIS Billing 3.0), its provider and its name from the Peppol Directory, a one-line summary first. 1 call; nothing is sent on the network. |

Limits are answered as tool errors, never as exceptions: a 429 says when to retry, a 402 says the free allowance is used, a 503 names the upstream that did not answer.

## Install in one line

```sh
claude mcp add veriport -e VERIPORT_API_KEY=vp_live_… -- npx -y @veriport/mcp
```

(`npx -y @veriport/mcp` once the package is on npm; until then `node mcp/server.mjs` from a checkout of the repository.)

Environment: `VERIPORT_API_KEY` (optional, `vp_live_…`; without it the API answers 20 calls a day per address), `VERIPORT_API_BASE` (defaults to `https://veriport.io/api/v1`).

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "veriport": {
      "command": "npx",
      "args": ["-y", "@veriport/mcp"],
      "env": { "VERIPORT_API_KEY": "vp_live_…" }
    }
  }
}
```

`claude mcp add veriport -e VERIPORT_API_KEY=vp_live_… -- npx -y @veriport/mcp`

### Cursor, Windsurf, Zed, Continue

The same `command` / `args` / `env` block in the client's MCP configuration; the server speaks the stdio transport with protocol version `2025-06-18` and advertises `tools` only.

## Test

```sh
node --test mcp/test/*.test.mjs
```

The test starts a fake API on a local port and drives the server over stdio: `initialize`, `tools/list`, the six tools (an invalid and a valid e-invoice, XML and PDF), the 429 / 503 / 422 / missing-argument states.

## Registry manifest and listings

`server.json` in this folder is the manifest of the official MCP registry (schema 2025-12-11; name `io.veriport/veriport`, the npm package `@veriport/mcp` over stdio, the two environment variables). Publication is the owner's step, in this order: `npm publish --access public` from this folder (the registry checks the `mcpName` field of `package.json` against the server name), then `mcp-publisher login github` and `mcp-publisher publish` from this folder. Directories (glama.ai, Smithery, Cursor) read the same manifest and the npm package.

Listing text: name `veriport`; category finance / data; licence MIT; publisher Janolab Studio LLC (Austin, Texas); homepage https://veriport.io/docs; source https://github.com/zenomoung/veriport-sdk (folder `mcp`). Not affiliated with the European Commission, SWIFT, INSEE or INPI; not tax advice.
