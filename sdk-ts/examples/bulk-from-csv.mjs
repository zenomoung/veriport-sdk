// node examples/bulk-from-csv.mjs numbers.csv results.csv — a paced loop over a CSV of VAT numbers (see https://veriport.io/guides/validate-eu-vat-numbers-in-bulk-from-csv).
import { readFile, writeFile } from 'node:fs/promises';
import { Veriport, VeriportError, checkVatStructure } from '@veriport/sdk';

const [input = 'numbers.csv', output = 'results.csv'] = process.argv.slice(2);
const vp = new Veriport({ apiKey: process.env.VERIPORT_KEY });
const numbers = [...new Set((await readFile(input, 'utf8')).split(/\r?\n/).map((l) => l.split(',')[0].trim().toUpperCase().replace(/[\s.-]/g, '')).filter(Boolean))];
const rows = [['number', 'valid', 'name', 'requestDate', 'source', 'stale', 'consultationNumber', 'status']];
const retry = [];
for (const n of numbers) {
  const structure = checkVatStructure(n);
  if (!structure.valid) {
    rows.push([n, 'false', '', '', 'structure_only', '', '', 'not_called']);
    continue; // impossible numbers never cost a call
  }
  try {
    const r = await vp.validateVat({ number: n, requester: process.env.MY_VAT_NUMBER });
    rows.push([r.full, String(r.valid), r.name ?? '', r.requestDate ?? '', r.source.kind, String(r.source.stale), r.consultationNumber ?? '', r.upstream.status]);
  } catch (e) {
    if (e instanceof VeriportError && (e.code === 'vies_unavailable' || e.code === 'vies_blocked')) retry.push(n);
    else if (e instanceof VeriportError && e.code === 'rate_limited') numbers.push(n);
    else rows.push([n, '', '', '', '', '', '', e instanceof VeriportError ? e.code : 'error']);
  }
  await new Promise((r) => setTimeout(r, 550)); // 2 requests a second on the free key
}
await writeFile(output, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n');
console.log(`${rows.length - 1} rows written to ${output}; ${retry.length} to retry: ${retry.join(' ')}`);
