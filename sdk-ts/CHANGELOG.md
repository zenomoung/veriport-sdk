# Changelog — @veriport/sdk

## 0.1.0 (prepared 2026-10-28, not yet published)

- First release: a client generated from the Veriport OpenAPI document (API version 2026-10-28.1): `validateVat`, `validateIban`, `vatRate`, `frCompany`, `createEInvoice`, `validateEInvoice`, `parseEInvoice`, and `call(operationId, …)` for every operation.
- MIT offline helpers: `checkVatStructure()` (the 28 EU VAT number formats) and `validateIbanOffline()` (the full IBAN check for the 88 countries of the registry), plus `checkVat()` / `checkIban()` that run offline first and call the API second.
- `VeriportError` with the stable problem `code`, `retryAfter` and the e-invoice details (`feature`, `unsupported`, `violations`); `vp.last` with the budget headers.
