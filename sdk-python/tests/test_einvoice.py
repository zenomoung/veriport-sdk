import asyncio
import json

import httpx
import pytest

from veriport import AsyncVeriport, EInvoiceFile, Veriport, VeriportError

INVOICE = {"format": "xrechnung-ubl", "number": "2026-017", "issueDate": "2026-10-20"}
XML = '<?xml version="1.0" encoding="UTF-8"?>\n<ubl:Invoice/>'
PDF = b"%PDF-1.7\n%%EOF\n"


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_create_einvoice_posts_json_with_idempotency_key_and_returns_the_file():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(url=str(request.url), method=request.method, ctype=request.headers.get("Content-Type"), idem=request.headers.get("Idempotency-Key"), auth=request.headers.get("Authorization"), body=json.loads(request.content))
        return httpx.Response(200, content=XML.encode(), headers={"Content-Type": "application/xml; charset=utf-8", "Content-Disposition": 'attachment; filename="xrechnung-ubl-2026-017.xml"', "Veriport-Validation": "valid; profile=xrechnung; errors=0; warnings=0", "Veriport-Defaults": "2"})

    vp = Veriport(api_key="vp_live_test", client=_client(handler))
    f = vp.create_einvoice(INVOICE, idempotency_key="inv-2026-017")
    assert isinstance(f, EInvoiceFile)
    assert seen["url"] == "https://veriport.io/api/v1/einvoice/create" and seen["method"] == "POST"
    assert seen["ctype"] == "application/json" and seen["idem"] == "inv-2026-017" and seen["auth"] == "Bearer vp_live_test"
    assert seen["body"] == INVOICE
    assert f.content == XML.encode() and f.filename == "xrechnung-ubl-2026-017.xml" and f.defaults == 2
    assert f.validation == "valid; profile=xrechnung; errors=0; warnings=0"


def test_create_einvoice_envelope():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("envelope") == "json"
        return httpx.Response(200, json={"format": "zugferd", "file": "JVBERi0=", "validation": {"valid": True}, "defaults": []})

    env = Veriport(api_key="k", client=_client(handler)).create_einvoice(INVOICE, envelope=True)
    assert env["validation"]["valid"] is True and env["file"] == "JVBERi0="


def test_refusals_carry_the_problem_extension_members():
    problems = [
        {"code": "einvoice_unsupported", "status": 422, "title": "t", "detail": "d", "feature": "attachments", "path": "attachments", "unsupported": [{"feature": "attachments", "path": "attachments", "detail": "x"}]},
        {"code": "einvoice_invalid", "status": 422, "title": "t", "detail": "d", "violations": [{"rule": "BR-DE-15", "severity": "fatal", "path": "buyerReference", "message": "m"}]},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json=problems.pop(0), headers={"Content-Type": "application/problem+json"})

    vp = Veriport(api_key="k", client=_client(handler))
    with pytest.raises(VeriportError) as e:
        vp.create_einvoice(INVOICE)
    assert e.value.code == "einvoice_unsupported" and e.value.feature == "attachments" and len(e.value.unsupported) == 1
    with pytest.raises(VeriportError) as e:
        vp.create_einvoice(INVOICE)
    assert e.value.code == "einvoice_invalid" and e.value.feature is None and e.value.violations[0]["rule"] == "BR-DE-15"


def test_validate_einvoice_content_types_and_anonymous_call():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("Content-Type"), request.headers.get("Authorization"), request.content))
        return httpx.Response(200, json={"valid": False, "profile": "peppol-bis", "errors": [{"rule": "PEPPOL-COMMON-R043"}], "warnings": []}, headers={"X-Tier": "anonymous"})

    vp = Veriport(client=_client(handler))
    r = vp.validate_einvoice(XML)
    assert r["errors"][0]["rule"] == "PEPPOL-COMMON-R043"
    vp.validate_einvoice(PDF)
    vp.validate_einvoice(XML.encode())
    assert seen[0][:3] == ("/api/v1/einvoice/validate", "application/xml", None) and seen[0][3] == XML.encode()
    assert seen[1][1] == "application/pdf" and seen[1][3] == PDF
    assert seen[2][1] == "application/xml"
    assert vp.last.tier == "anonymous"


def test_parse_einvoice_json_and_pdf():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("as") == "pdf":
            assert request.url.params.get("lang") == "fr"
            return httpx.Response(200, content=PDF, headers={"Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="readable-copy-2026-017.pdf"'})
        return httpx.Response(200, json={"invoice": INVOICE, "format": "xrechnung-ubl", "notInJson": []})

    vp = Veriport(api_key="k", client=_client(handler))
    assert vp.parse_einvoice(XML)["invoice"]["number"] == "2026-017"
    pdf = vp.parse_einvoice(XML, as_="pdf", lang="fr")
    assert isinstance(pdf, EInvoiceFile) and pdf.content == PDF and pdf.filename == "readable-copy-2026-017.pdf"
    with pytest.raises(ValueError):
        vp.parse_einvoice(XML, as_="html")


def test_async_client_validates():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("Content-Type") == "application/pdf"
        return httpx.Response(200, json={"valid": True, "profile": "en16931"})

    async def run():
        async with AsyncVeriport(client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as vp:
            return await vp.validate_einvoice(PDF)

    assert asyncio.run(run())["profile"] == "en16931"


def test_a_body_over_the_limit_is_refused_before_sending():
    from veriport._tables import REQUEST_MAX_BYTES

    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"valid": True, "errors": [], "warnings": []})

    vp = Veriport(client=_client(handler))
    with pytest.raises(VeriportError) as err:
        vp.validate_einvoice(b"x" * (REQUEST_MAX_BYTES + 1))
    assert err.value.status == 413 and err.value.code == "payload_too_large"
    assert sent == []
    vp.validate_einvoice(b"x" * REQUEST_MAX_BYTES)
    assert len(sent) == 1


def test_the_platform_bare_413_becomes_payload_too_large():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(413, text="Request Entity Too Large", headers={"X-Vercel-Error": "FUNCTION_PAYLOAD_TOO_LARGE"})

    with pytest.raises(VeriportError) as err:
        Veriport(client=_client(handler)).validate_einvoice(XML)
    assert err.value.code == "payload_too_large" and err.value.status == 413

