"""python examples/validate_vat.py DE136695976 — one VAT number, the provenance printed with the verdict."""
import os
import sys

from veriport import Veriport, VeriportError

vp = Veriport(api_key=os.environ.get("VERIPORT_KEY"))  # optional for the first 20 calls a day
number = sys.argv[1] if len(sys.argv) > 1 else "DE136695976"
try:
    r = vp.validate_vat(number, requester=os.environ.get("MY_VAT_NUMBER"))
    stale = ", stale" if r["source"]["stale"] else ""
    print(f"{r['full']}: {'valid' if r['valid'] else 'not registered'} ({r['source']['kind']}{stale}, dated {r['requestDate']})")
    if r.get("name"):
        print(f"  {r['name']} — {r.get('address') or ''}")
    if r.get("consultationNumber"):
        print(f"  consultation number {r['consultationNumber']}")
except VeriportError as e:
    if e.code == "vies_unavailable":
        print(f"VIES or the member state is down and no cached answer exists; retry in {e.retry_after} s", file=sys.stderr)
    else:
        raise
