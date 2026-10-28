"""A thin httpx client for the Veriport API (https://veriport.io/docs).

One ``call(method, path, params=..., json=...)`` and a few named methods; every
non-2xx answer is the API's RFC 9457 problem document, raised as
:class:`VeriportError` with the stable ``code``. Works synchronously and, through
:class:`AsyncVeriport`, with asyncio.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, Optional
from urllib.parse import quote

import httpx

from ._tables import API_VERSION
from .errors import VeriportError

DEFAULT_BASE_URL = "https://veriport.io/api/v1"
_USER_AGENT = f"veriport-sdk-python/{API_VERSION}"


class CallMeta:
    """What the API said about the budget on the last answer (RateLimit-* and X-Quota-Remaining headers)."""

    __slots__ = ("status", "tier", "rate_limit", "rate_remaining", "quota_remaining", "request_id")

    def __init__(self, response: httpx.Response) -> None:
        h = response.headers
        self.status = response.status_code
        self.tier = h.get("X-Tier")
        self.rate_limit = _int(h.get("RateLimit-Limit"))
        self.rate_remaining = _int(h.get("RateLimit-Remaining"))
        self.quota_remaining = _int(h.get("X-Quota-Remaining"))
        self.request_id = h.get("X-Request-Id")

    def __repr__(self) -> str:  # pragma: no cover
        return f"CallMeta(status={self.status}, tier={self.tier!r}, quota_remaining={self.quota_remaining})"


def _int(value: Optional[str]) -> Optional[int]:
    try:
        return int(value) if value not in (None, "") else None
    except ValueError:
        return None


def _headers(api_key: Optional[str]) -> Dict[str, str]:
    h = {"Accept": "application/json", "User-Agent": _USER_AGENT}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def _raise_for_problem(response: httpx.Response) -> Any:
    try:
        body = response.json() if response.content else None
    except ValueError:
        body = None
    if response.is_success:
        return body
    problem = body if isinstance(body, dict) else {"title": response.reason_phrase, "status": response.status_code}
    retry_after = response.headers.get("Retry-After") or problem.get("retryAfter")
    raise VeriportError(response.status_code, problem, CallMeta(response), int(retry_after) if retry_after is not None else None)


class Veriport:
    """Synchronous client.

    ``api_key`` is optional: without it the API answers a small daily allowance
    per address. ``base_url`` points at the production API unless you run a
    preview or a local instance. Pass your own ``httpx.Client`` for pooling,
    proxies or a mock transport in tests.
    """

    def __init__(self, api_key: Optional[str] = None, base_url: str = DEFAULT_BASE_URL, timeout: float = 15.0, client: Optional[httpx.Client] = None) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=timeout)
        self.last: Optional[CallMeta] = None

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Veriport":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def call(self, method: str, path: str, params: Optional[Dict[str, Any]] = None, json: Any = None) -> Any:
        """Any operation of the OpenAPI document: ``call("GET", "/vat/validate", params={"number": "DE136695976"})``."""
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        response = self._client.request(method, f"{self.base_url}{path}", params=clean, json=json, headers=_headers(self.api_key))
        self.last = CallMeta(response)
        return _raise_for_problem(response)

    # ---- named operations

    def validate_vat(self, number: str, country: Optional[str] = None, requester: Optional[str] = None) -> Dict[str, Any]:
        """GET /vat/validate: structure and check digit, then VIES live or the dated cache. ``number`` may carry the prefix."""
        return self.call("GET", "/vat/validate", params={"number": number, "country": country, "requester": requester})

    def validate_vat_bulk(self, items: Iterable[Dict[str, str]], requester: Optional[str] = None) -> Dict[str, Any]:
        """POST /vat/validate/bulk (monthly plan): one result per item, a problem document in a failed slot."""
        body: Dict[str, Any] = {"items": list(items)}
        if requester:
            body["requester"] = requester
        return self.call("POST", "/vat/validate/bulk", json=body)

    def vat_rates(self, category: Optional[str] = None) -> Dict[str, Any]:
        """GET /vat/rates: the 27 rows, or one category across the Union."""
        return self.call("GET", "/vat/rates", params={"category": category})

    def vat_rate(self, country: str) -> Dict[str, Any]:
        """GET /vat/rates/{country}: one member state with its verifiedOn and sources."""
        return self.call("GET", f"/vat/rates/{country}")

    def validate_iban(self, iban: str) -> Dict[str, Any]:
        """GET /iban/validate: the five checks, bank and branch identifiers, SEPA flag. Spaces allowed."""
        return self.call("GET", "/iban/validate", params={"iban": iban})

    def validate_iban_bulk(self, ibans: Iterable[str]) -> Dict[str, Any]:
        """POST /iban/validate/bulk (monthly plan)."""
        return self.call("POST", "/iban/validate/bulk", json={"ibans": list(ibans)})

    def fr_company(self, identifier: str) -> Dict[str, Any]:
        """GET /fr/company/{id}: SIREN, SIRET or French VAT number to the registry record."""
        return self.call("GET", f"/fr/company/{quote(identifier, safe='')}")

    def us_sales_tax(self, zip_code: str) -> Dict[str, Any]:
        """GET /us/sales-tax?zip=."""
        return self.call("GET", "/us/sales-tax", params={"zip": zip_code})

    def me(self) -> Dict[str, Any]:
        """GET /me: the key's tier, usage and credits (key required)."""
        return self.call("GET", "/me")

    def status(self) -> Dict[str, Any]:
        """GET /status: components and VIES availability per member state."""
        return self.call("GET", "/status")


class AsyncVeriport:
    """The same client over ``httpx.AsyncClient``."""

    def __init__(self, api_key: Optional[str] = None, base_url: str = DEFAULT_BASE_URL, timeout: float = 15.0, client: Optional[httpx.AsyncClient] = None) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self.last: Optional[CallMeta] = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncVeriport":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def call(self, method: str, path: str, params: Optional[Dict[str, Any]] = None, json: Any = None) -> Any:
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        response = await self._client.request(method, f"{self.base_url}{path}", params=clean, json=json, headers=_headers(self.api_key))
        self.last = CallMeta(response)
        return _raise_for_problem(response)

    async def validate_vat(self, number: str, country: Optional[str] = None, requester: Optional[str] = None) -> Dict[str, Any]:
        return await self.call("GET", "/vat/validate", params={"number": number, "country": country, "requester": requester})

    async def vat_rates(self, category: Optional[str] = None) -> Dict[str, Any]:
        return await self.call("GET", "/vat/rates", params={"category": category})

    async def vat_rate(self, country: str) -> Dict[str, Any]:
        return await self.call("GET", f"/vat/rates/{country}")

    async def validate_iban(self, iban: str) -> Dict[str, Any]:
        return await self.call("GET", "/iban/validate", params={"iban": iban})

    async def fr_company(self, identifier: str) -> Dict[str, Any]:
        return await self.call("GET", f"/fr/company/{quote(identifier, safe='')}")

    async def us_sales_tax(self, zip_code: str) -> Dict[str, Any]:
        return await self.call("GET", "/us/sales-tax", params={"zip": zip_code})

    async def me(self) -> Dict[str, Any]:
        return await self.call("GET", "/me")

    async def status(self) -> Dict[str, Any]:
        return await self.call("GET", "/status")
