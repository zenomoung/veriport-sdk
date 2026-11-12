"""python examples/check_iban_offline.py "DE89 3704 0044 0532 0130 00" — the full IBAN check without a network call (MIT)."""
import sys

from veriport import validate_iban_offline

iban = sys.argv[1] if len(sys.argv) > 1 else "DE89 3704 0044 0532 0130 00"
r = validate_iban_offline(iban)
verdict = "well formed" if r.valid else f"invalid ({', '.join(r.failures)})"
print(f"{r.formatted}: {verdict}; bank {r.bank_identifier or '—'}; SEPA {r.sepa}")
