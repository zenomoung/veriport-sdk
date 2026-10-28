"""Veriport: the EU counterparty check as an API (VAT number on VIES, French company, IBAN) and EU VAT rates, every answer dated and sourced. https://veriport.io/docs"""
from ._tables import API_VERSION, IBAN_REGISTRY, VAT_FORMATS
from .client import DEFAULT_BASE_URL, AsyncVeriport, CallMeta, Veriport
from .errors import VeriportError
from .offline import IbanCheck, VatStructure, check_vat_structure, format_iban, iban_check_digits, iban_mod97, normalise_iban, normalise_vat, validate_iban_offline

__version__ = "0.1.0"
__all__ = ["Veriport", "AsyncVeriport", "VeriportError", "CallMeta", "DEFAULT_BASE_URL", "API_VERSION", "VAT_FORMATS", "IBAN_REGISTRY", "VatStructure", "IbanCheck", "check_vat_structure", "normalise_vat", "validate_iban_offline", "iban_mod97", "iban_check_digits", "normalise_iban", "format_iban", "check_vat", "check_iban"]


def check_vat(number: str, client: "Veriport | None" = None, country: "str | None" = None, requester: "str | None" = None) -> dict:
    """Structure first, then the API only when the structure passes and a client is given: an impossible number never costs a call."""
    structure = check_vat_structure(number, country)
    if not structure.valid or client is None:
        return {"kind": "structure_only", "structure": structure, "answer": None}
    return {"kind": "api", "structure": structure, "answer": client.validate_vat(structure.vat_number or "", country=structure.country_code, requester=requester)}


def check_iban(iban: str, client: "Veriport | None" = None) -> dict:
    """Offline first, then the API only when a client is given and the offline check passed."""
    offline = validate_iban_offline(iban)
    if not offline.valid or client is None:
        return {"kind": "offline", "offline": offline, "answer": None}
    return {"kind": "api", "offline": offline, "answer": client.validate_iban(offline.iban)}
