from veriport import IBAN_REGISTRY, VAT_FORMATS, check_iban, check_vat, check_vat_structure, iban_check_digits, iban_mod97, normalise_vat, validate_iban_offline


def test_vat_examples_pass_structure():
    for code, fmt in VAT_FORMATS.items():
        r = check_vat_structure(fmt["example"])
        assert r.valid, f"{code} {fmt['example']} {r.reason}"
        assert r.country_code == code
        assert r.full == fmt["example"]


def test_vat_normalisation():
    assert normalise_vat("de 136.695-976") == {"country_code": "DE", "vat_number": "136695976"}
    assert normalise_vat("GR094259216") == {"country_code": "EL", "vat_number": "094259216"}
    assert normalise_vat("136695976", "de") == {"country_code": "DE", "vat_number": "136695976"}
    assert check_vat_structure("DE12345").reason == "pattern"
    assert check_vat_structure("XX123").reason == "country_unknown"
    assert check_vat_structure("").reason == "empty"


def test_iban_examples():
    de = validate_iban_offline("DE89 3704 0044 0532 0130 00")
    assert de.valid and de.bank_identifier == "37040044" and de.sepa is True
    gb = validate_iban_offline("GB29 NWBK 6016 1331 9268 19")
    assert gb.valid and gb.bank_identifier == "NWBK" and gb.branch_identifier == "601613"
    assert validate_iban_offline("FR14 2004 1010 0505 0001 3M02 606").valid


def test_iban_failures_are_named():
    assert validate_iban_offline("DE89 3704 0044 0532 0130 01").failures == ["check_digits"]
    assert validate_iban_offline("ZZ89 3704").failures == ["country_unknown"]
    assert validate_iban_offline("DE89 3704 0044 0532 0130 0!").failures == ["characters"]
    assert validate_iban_offline("").failures == ["empty"]


def test_check_digits_for_every_registry_entry():
    assert len(IBAN_REGISTRY) >= 80
    for code, c in IBAN_REGISTRY.items():
        bban = "1" * (c["length"] - 4)
        assert iban_mod97(f"{code}{iban_check_digits(code, bban)}{bban}") == 1, code


class _Fake:
    def __init__(self):
        self.calls = 0

    def validate_vat(self, number, country=None, requester=None):
        self.calls += 1
        return {"valid": True, "number": number, "country": country, "requester": requester}

    def validate_iban(self, iban):
        self.calls += 1
        return {"valid": True}


def test_check_vat_and_iban_skip_the_api_for_impossible_input():
    fake = _Fake()
    assert check_vat("DE12", client=fake)["kind"] == "structure_only"
    assert fake.calls == 0
    r = check_vat("DE136695976", client=fake, requester="FR40303265045")
    assert r["kind"] == "api" and r["answer"]["country"] == "DE" and fake.calls == 1
    assert check_iban("DE00", client=fake)["kind"] == "offline"
    assert check_iban("DE89370400440532013000", client=fake)["kind"] == "api"
    assert fake.calls == 2
