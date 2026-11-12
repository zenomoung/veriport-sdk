"""python examples/bulk_from_csv.py numbers.csv results.csv — a paced loop over a CSV of VAT numbers
(see https://veriport.io/guides/validate-eu-vat-numbers-in-bulk-from-csv)."""
import csv
import os
import sys
import time

from veriport import Veriport, VeriportError, check_vat_structure

inp = sys.argv[1] if len(sys.argv) > 1 else "numbers.csv"
out_path = sys.argv[2] if len(sys.argv) > 2 else "results.csv"
vp = Veriport(api_key=os.environ.get("VERIPORT_KEY"))
requester = os.environ.get("MY_VAT_NUMBER")

seen, numbers = set(), []
with open(inp, newline="", encoding="utf-8") as f:
    for row in csv.reader(f):
        n = row[0].strip().upper().replace(" ", "").replace(".", "").replace("-", "") if row else ""
        if n and n not in seen:
            seen.add(n)
            numbers.append(n)

retry = []
with open(out_path, "w", newline="", encoding="utf-8") as f:
    out = csv.writer(f)
    out.writerow(["number", "valid", "name", "requestDate", "source", "stale", "consultationNumber", "status"])
    for n in numbers:
        if not check_vat_structure(n).valid:
            out.writerow([n, False, "", "", "structure_only", "", "", "not_called"])  # never costs a call
            continue
        try:
            r = vp.validate_vat(n, requester=requester)
            out.writerow([r["full"], r["valid"], r.get("name") or "", r.get("requestDate") or "", r["source"]["kind"], r["source"]["stale"], r.get("consultationNumber") or "", r["upstream"]["status"]])
        except VeriportError as e:
            if e.code in ("vies_unavailable", "vies_blocked"):
                retry.append(n)
            elif e.code == "rate_limited":
                numbers.append(n)
            else:
                out.writerow([n, "", "", "", "", "", "", e.code])
        time.sleep(0.55)  # 2 requests a second on the free key
print(f"{out_path} written; {len(retry)} to retry: {' '.join(retry)}")
