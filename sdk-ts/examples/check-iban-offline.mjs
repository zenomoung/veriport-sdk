// node examples/check-iban-offline.mjs "DE89 3704 0044 0532 0130 00" — the full IBAN check without a network call (MIT), then the API's answer when a key is set.
import { checkIban } from '@veriport/sdk';
import { validateIbanOffline } from '@veriport/sdk/offline';

const iban = process.argv[2] ?? 'DE89 3704 0044 0532 0130 00';
const offline = validateIbanOffline(iban);
console.log(`${offline.formatted}: ${offline.valid ? 'well formed' : `invalid (${offline.failures.join(', ')})`}; bank ${offline.bankIdentifier ?? '—'}; SEPA ${offline.sepa}`);

if (process.env.VERIPORT_KEY) {
  const { Veriport } = await import('@veriport/sdk');
  const both = await checkIban(iban, { client: new Veriport({ apiKey: process.env.VERIPORT_KEY }) });
  console.log(`API agrees: ${both.answer?.valid}; registry ${both.answer?.registry?.verifiedOn}`);
}
