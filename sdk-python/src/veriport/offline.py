"""The offline parts of the two checks, no network: the structure of an EU VAT
number (the Commission's published structures; the check digit and the
registration are VIES's and the API's job) and the full IBAN check (characters,
country, length, ISO 7064 mod 97-10, BBAN pattern from the SWIFT registry, bank
and branch identifiers, SEPA flag). Both read the generated tables the API uses.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ._tables import IBAN_REGISTRY, VAT_FORMATS

__all__ = ["VatStructure", "check_vat_structure", "normalise_vat", "IbanCheck", "validate_iban_offline", "iban_mod97", "iban_check_digits", "bban_regex", "normalise_iban", "format_iban", "VAT_FORMATS", "IBAN_REGISTRY"]


# ---------------------------------------------------------------- VAT numbers


@dataclass
class VatStructure:
    valid: bool
    country_code: Optional[str]
    vat_number: Optional[str]
    full: Optional[str]
    expected: Optional[str]
    reason: Optional[str]  # "empty" | "country_unknown" | "pattern"


def normalise_vat(value: str, country: Optional[str] = None) -> Dict[str, Optional[str]]:
    """Splits "DE 136 695 976", "de136695976" or ("136695976", "DE"); GR becomes EL; a repeated prefix is removed."""
    s = re.sub(r"[\s.\-_/]", "", (value or "").upper())
    cc = re.sub(r"[^A-Z]", "", (country or "").upper()) or None
    if cc == "GR":
        cc = "EL"
    m = re.match(r"^([A-Z]{2})(.*)$", s)
    if m and (m.group(1) in VAT_FORMATS or m.group(1) == "GR"):
        prefix = "EL" if m.group(1) == "GR" else m.group(1)
        if cc is None or cc == prefix:
            cc = prefix
            s = m.group(2)
    return {"country_code": cc, "vat_number": s}


def check_vat_structure(value: str, country: Optional[str] = None) -> VatStructure:
    """True means the string has the shape of a VAT number of that state, nothing more."""
    n = normalise_vat(value, country)
    cc, number = n["country_code"], n["vat_number"] or ""
    if not number and not cc:
        return VatStructure(False, None, None, None, None, "empty")
    fmt = VAT_FORMATS.get(cc) if cc else None
    if not fmt:
        return VatStructure(False, cc, number or None, None, None, "country_unknown")
    ok = re.match(fmt["pattern"], number) is not None
    return VatStructure(ok, cc, number, f"{cc}{number}", fmt["structure"], None if ok else "pattern")


# ----------------------------------------------------------------------- IBAN


@dataclass
class IbanCheck:
    valid: bool
    iban: str
    formatted: str
    country_code: Optional[str] = None
    country_name: Optional[str] = None
    check_digits: Optional[str] = None
    bban: Optional[str] = None
    bank_identifier: Optional[str] = None
    branch_identifier: Optional[str] = None
    expected_length: Optional[int] = None
    sepa: Optional[bool] = None
    sepa_since: Optional[str] = None
    checks: Dict[str, bool] = field(default_factory=lambda: {"characters": False, "country": False, "length": False, "mod97": False, "bban_pattern": False})
    failures: List[str] = field(default_factory=list)


def normalise_iban(value: str) -> str:
    return re.sub(r"[\s\-.]", "", (value or "").upper())


def format_iban(compact: str) -> str:
    return " ".join(compact[i : i + 4] for i in range(0, len(compact), 4))


def bban_regex(bban: str) -> "re.Pattern[str]":
    """The registry notation ("4!a6!n8!n") compiled to a regular expression over the BBAN."""
    parts = []
    for length, fixed, kind in re.findall(r"(\d+)(!?)([anc])", bban):
        cls = "[0-9]" if kind == "n" else "[A-Z]" if kind == "a" else "[A-Z0-9]"
        parts.append(f"{cls}{{{length}}}" if fixed else f"{cls}{{1,{length}}}")
    return re.compile("^" + "".join(parts) + "$")


def iban_mod97(iban: str) -> int:
    """ISO 7064 mod 97-10 remainder (letters A–Z → 10–35, the first four characters moved to the end); valid when 1."""
    rearranged = iban[4:] + iban[:4]
    r = 0
    for ch in rearranged:
        v = str(ord(ch) - 55) if "A" <= ch <= "Z" else ch
        for d in v:
            r = (r * 10 + int(d)) % 97
    return r


def iban_check_digits(country: str, bban: str) -> str:
    """The two check digits for a country and a BBAN."""
    return str(98 - iban_mod97(f"{country}00{bban}")).zfill(2)


def validate_iban_offline(value: str) -> IbanCheck:
    """The full offline IBAN check, the same five rules as GET /iban/validate."""
    iban = normalise_iban(value)
    out = IbanCheck(False, iban, format_iban(iban))
    if not iban:
        out.failures = ["empty"]
        return out
    if not re.match(r"^[A-Z0-9]+$", iban):
        out.failures = ["characters"]
        return out
    out.checks["characters"] = True
    code = iban[:2]
    country = IBAN_REGISTRY.get(code)
    if not re.match(r"^[A-Z]{2}[0-9]{2}", iban) or not country:
        out.country_code = code if re.match(r"^[A-Z]{2}", iban) else None
        out.failures = ["country_unknown"]
        return out
    out.checks["country"] = True
    out.country_code = code
    out.country_name = country["name"]
    out.expected_length = country["length"]
    out.sepa = country["sepa"]
    out.sepa_since = country["sepa_since"]
    out.check_digits = iban[2:4]
    failures: List[str] = []
    if len(iban) != country["length"]:
        failures.append("length")
    else:
        out.checks["length"] = True
    if iban_mod97(iban) == 1:
        out.checks["mod97"] = True
    else:
        failures.append("check_digits")
    bban = iban[4:]
    out.bban = bban
    if bban_regex(country["bban"]).match(bban):
        out.checks["bban_pattern"] = True
    else:
        failures.append("bban_pattern")
    if country["bank_id"] and out.checks["length"]:
        start, length = country["bank_id"]
        out.bank_identifier = bban[start : start + length]
    if country["branch_id"] and out.checks["length"]:
        start, length = country["branch_id"]
        out.branch_identifier = bban[start : start + length]
    out.failures = failures
    out.valid = not failures
    return out
