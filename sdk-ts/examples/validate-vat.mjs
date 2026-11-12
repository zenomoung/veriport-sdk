// node examples/validate-vat.mjs DE136695976 — one VAT number, the provenance printed with the verdict.
import { Veriport, VeriportError } from '@veriport/sdk';

const vp = new Veriport({ apiKey: process.env.VERIPORT_KEY }); // optional for the first 20 calls a day
const number = process.argv[2] ?? 'DE136695976';
try {
  const r = await vp.validateVat({ number, requester: process.env.MY_VAT_NUMBER });
  console.log(`${r.full}: ${r.valid ? 'valid' : 'not registered'} (${r.source.kind}${r.source.stale ? ', stale' : ''}, dated ${r.requestDate})`);
  if (r.name) console.log(`  ${r.name} — ${r.address ?? ''}`);
  if (r.consultationNumber) console.log(`  consultation number ${r.consultationNumber}`);
} catch (e) {
  if (e instanceof VeriportError && e.code === 'vies_unavailable') console.error(`VIES or the member state is down and no cached answer exists; retry in ${e.retryAfter} s`);
  else throw e;
}
