import json

import httpx
import pytest

from veriport import Veriport, VeriportError


def _transport(handler):
    return httpx.MockTransport(handler)


def test_builds_url_sends_key_and_reads_budget_headers():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"valid": True}, headers={"RateLimit-Limit": "2", "RateLimit-Remaining": "1", "X-Quota-Remaining": "99", "X-Tier": "free"})

    vp = Veriport(api_key="vp_live_test", client=httpx.Client(transport=_transport(handler)))
    assert vp.validate_vat("136695976", country="DE") == {"valid": True}
    assert seen["url"] == "https://veriport.io/api/v1/vat/validate?number=136695976&country=DE"
    assert seen["auth"] == "Bearer vp_live_test"
    assert vp.last.tier == "free" and vp.last.quota_remaining == 99 and vp.last.rate_remaining == 1


def test_path_encoding_and_post_body():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.raw_path.decode(), request.content))
        return httpx.Response(200, json={})

    vp = Veriport(base_url="http://localhost:3074/api/v1/", client=httpx.Client(transport=_transport(handler)))
    vp.fr_company("356 000 000")
    vp.validate_iban_bulk(["DE89370400440532013000"])
    vp.vat_rate("fr")
    assert seen[0][1] == "/api/v1/fr/company/356%20000%20000"
    assert seen[1][0] == "POST" and json.loads(seen[1][2]) == {"ibans": ["DE89370400440532013000"]}
    assert seen[2][1] == "/api/v1/vat/rates/fr"


def test_problem_documents_become_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"code": "vies_unavailable", "title": "VIES did not answer", "status": 503, "detail": "retry", "retryAfter": 30}, headers={"Retry-After": "30"})

    vp = Veriport(client=httpx.Client(transport=_transport(handler)))
    with pytest.raises(VeriportError) as e:
        vp.validate_vat("DE136695976")
    assert e.value.code == "vies_unavailable" and e.value.status == 503 and e.value.retry_after == 30 and e.value.retryable
