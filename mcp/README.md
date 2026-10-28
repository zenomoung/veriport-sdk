# Veriport MCP server

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server over stdio that gives an agent three deterministic checks from the [Veriport API](https://veriport.io): no dependency, one file, Node 18+.

| Tool | What it does |
|---|---|
| `validate_vat` | Structure and national check digit, then the European Commission's VIES live; returns `valid`, the registered name and address where published, the date, and the provenance (`source.kind` live / cache / structure_only, `source.stale`); the VIES consultation number with `requester` on a paid key. |
| `validate_iban` | The five IBAN checks (characters, country, length, mod 97-10, BBAN pattern), the failed rules, bank and branch identifiers, SEPA flag. Does not say whether the account exists. |
| `vat_rate` | Standard, reduced, super-reduced and parking VAT rates of one EU member state with seven category hints, `verifiedOn` and the official sources; or one category across the 27 states. |

Limits are answered as tool errors, never as exceptions: a 429 says when to retry, a 402 says the free allowance is used, a 503 names the upstream that did not answer.

## Run

```sh
npx @veriport/mcp            # once published; until then: node mcp/server.mjs from this repository
```

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

The test starts a fake API on a local port and drives the server over stdio: `initialize`, `tools/list`, the three tools, the 429 / 503 / missing-argument states.

## Directory listing

Name `veriport`; category finance / data; licence MIT; publisher Janolab Studio LLC (Austin, Texas); homepage https://veriport.io/docs; source: the `mcp/` folder of the Veriport repository; `mcpName` `io.veriport/veriport`. Not affiliated with the European Commission, SWIFT, INSEE or INPI; not tax advice.
