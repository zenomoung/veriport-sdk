"""A thin httpx client for the Veriport API (https://veriport.io/docs).

One ``call(method, path, params=..., json=...)`` and a few named methods; every
non-2xx answer is the API's RFC 9457 problem document, raised as
:class:`VeriportError` with the stable ``code``. Works synchronously and, through
:class:`AsyncVeriport`, with asyncio.
"""
from __future__ import annotations

import json as json_lib
import re
from typing import Any, Dict, Iterable, Optional, Tuple, Union
from urllib.parse import quote

import httpx

from ._tables import API_VERSION, REQUEST_MAX_BYTES
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


def _headers(api_key: Optional[str], extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    h = {"Accept": "application/json", "User-Agent": _USER_AGENT}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    h.update(extra or {})
    return h


def _raise_for_problem(response: httpx.Response) -> Any:
    try:
        body = response.json() if response.content else None
    except ValueError:
        body = None
    if response.is_success:
        return body
    if response.status_code == 413 and not (isinstance(body, dict) and body.get("code")):
        # A body over the limit is answered by the hosting platform, not the API: no problem document, so it is named here.
        raise _too_large(None, CallMeta(response))
    problem = body if isinstance(body, dict) else {"title": response.reason_phrase, "status": response.status_code}
    retry_after = response.headers.get("Retry-After") or problem.get("retryAfter")
    raise VeriportError(response.status_code, problem, CallMeta(response), int(retry_after) if retry_after is not None else None)


def _too_large(size: Optional[int], meta: Any) -> VeriportError:
    limit = f"one request is limited to {REQUEST_MAX_BYTES} bytes (4.5 MB); send the XML rather than a PDF carrying large attachments, or split the upload."
    detail = f"The request was refused before it reached the API: {limit}" if size is None else f"{size} bytes; {limit}"
    return VeriportError(413, {"code": "payload_too_large", "status": 413, "title": "Too many rows or too many bytes", "detail": detail}, meta, None)


def _check_size(content: Union[bytes, str]) -> None:
    size = len(content.encode("utf-8")) if isinstance(content, str) else len(content)
    if size > REQUEST_MAX_BYTES:
        raise _too_large(size, None)


class EInvoiceFile:
    """A file the e-invoice endpoints return: the XML or PDF bytes, the content type, the file name and, for a created file, the ``Veriport-Validation`` summary and the number of defaults the engine applied."""

    __slots__ = ("content", "content_type", "filename", "validation", "defaults")

    def __init__(self, response: httpx.Response) -> None:
        self.content: bytes = response.content
        self.content_type: str = response.headers.get("Content-Type", "application/octet-stream")
        disposition = response.headers.get("Content-Disposition", "")
        match = re.search(r'filename="([^"]+)"', disposition)
        self.filename: Optional[str] = match.group(1) if match else None
        self.validation: Optional[str] = response.headers.get("Veriport-Validation")
        self.defaults: Optional[int] = _int(response.headers.get("Veriport-Defaults"))

    def __repr__(self) -> str:  # pragma: no cover
        return f"EInvoiceFile(filename={self.filename!r}, content_type={self.content_type!r}, bytes={len(self.content)}, validation={self.validation!r})"


def _document(file: Union[bytes, bytearray, str], content_type: Optional[str]) -> Tuple[bytes, str]:
    """The body and Content-Type of a validate or parse request: XML text as application/xml, bytes starting with %PDF as application/pdf."""
    if isinstance(file, str):
        return file.encode("utf-8"), content_type or "application/xml"
    data = bytes(file)
    return data, content_type or ("application/pdf" if data[:4] == b"%PDF" else "application/xml")


def _create_request(invoice: Dict[str, Any], envelope: bool, idempotency_key: Optional[str]) -> Tuple[Dict[str, Any], Dict[str, str], str]:
    params = {"envelope": "json"} if envelope else {}
    headers = {"Content-Type": "application/json", "Accept": "application/json" if envelope else "application/xml, application/pdf, application/problem+json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    return params, headers, json_lib.dumps(invoice)


def _parse_params(as_: str, lang: Optional[str]) -> Dict[str, Any]:
    if as_ not in ("json", "pdf"):
        raise ValueError("as_ is 'json' or 'pdf'")
    return {"as": "pdf", "lang": lang} if as_ == "pdf" else {}


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
        if json is not None:
            _check_size(json_lib.dumps(json, separators=(",", ":"), ensure_ascii=False))
        response = self._client.request(method, f"{self.base_url}{path}", params=clean, json=json, headers=_headers(self.api_key))
        self.last = CallMeta(response)
        return _raise_for_problem(response)

    def _send(self, method: str, path: str, params: Optional[Dict[str, Any]], content: Union[bytes, str], headers: Dict[str, str]) -> httpx.Response:
        _check_size(content)
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        response = self._client.request(method, f"{self.base_url}{path}", params=clean, content=content, headers=_headers(self.api_key, headers))
        self.last = CallMeta(response)
        if not response.is_success:
            _raise_for_problem(response)
        return response

    # ---- named operations

    def create_einvoice(self, invoice: Dict[str, Any], envelope: bool = False, idempotency_key: Optional[str] = None) -> Union[EInvoiceFile, Dict[str, Any]]:
        """POST /einvoice/create (key required, 20 calls): the invoice JSON to the e-invoice file of ``invoice["format"]`` (XRechnung UBL or CII, the ZUGFeRD / Factur-X PDF, Peppol BIS). ``envelope=True`` returns the JSON envelope {file (base64), contentType, validation, defaults}. Refusals raise VeriportError (``einvoice_unsupported`` with ``feature``, ``einvoice_invalid`` with ``violations``)."""
        params, headers, body = _create_request(invoice, envelope, idempotency_key)
        response = self._send("POST", "/einvoice/create", params, body, headers)
        return response.json() if envelope else EInvoiceFile(response)

    def validate_einvoice(self, file: Union[bytes, bytearray, str], content_type: Optional[str] = None) -> Dict[str, Any]:
        """POST /einvoice/validate (5 calls; works without a key on the daily allowance): the XML schema and the official CEN, XRechnung or Peppol rules on an XML file or a hybrid PDF."""
        content, ctype = _document(file, content_type)
        return self._send("POST", "/einvoice/validate", None, content, {"Content-Type": ctype}).json()

    def parse_einvoice(self, file: Union[bytes, bytearray, str], as_: str = "json", lang: Optional[str] = None, content_type: Optional[str] = None) -> Union[Dict[str, Any], EInvoiceFile]:
        """POST /einvoice/parse (key required, 5 calls): the invoice JSON of a received e-invoice and ``notInJson``; ``as_="pdf"`` returns a readable PDF copy (``lang`` de, en, fr or nl)."""
        content, ctype = _document(file, content_type)
        response = self._send("POST", "/einvoice/parse", _parse_params(as_, lang), content, {"Content-Type": ctype, "Accept": "application/pdf, application/problem+json" if as_ == "pdf" else "application/json"})
        return EInvoiceFile(response) if as_ == "pdf" else response.json()

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
        if json is not None:
            _check_size(json_lib.dumps(json, separators=(",", ":"), ensure_ascii=False))
        response = await self._client.request(method, f"{self.base_url}{path}", params=clean, json=json, headers=_headers(self.api_key))
        self.last = CallMeta(response)
        return _raise_for_problem(response)

    async def _send(self, method: str, path: str, params: Optional[Dict[str, Any]], content: Union[bytes, str], headers: Dict[str, str]) -> httpx.Response:
        _check_size(content)
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        response = await self._client.request(method, f"{self.base_url}{path}", params=clean, content=content, headers=_headers(self.api_key, headers))
        self.last = CallMeta(response)
        if not response.is_success:
            _raise_for_problem(response)
        return response

    async def create_einvoice(self, invoice: Dict[str, Any], envelope: bool = False, idempotency_key: Optional[str] = None) -> Union[EInvoiceFile, Dict[str, Any]]:
        params, headers, body = _create_request(invoice, envelope, idempotency_key)
        response = await self._send("POST", "/einvoice/create", params, body, headers)
        return response.json() if envelope else EInvoiceFile(response)

    async def validate_einvoice(self, file: Union[bytes, bytearray, str], content_type: Optional[str] = None) -> Dict[str, Any]:
        content, ctype = _document(file, content_type)
        return (await self._send("POST", "/einvoice/validate", None, content, {"Content-Type": ctype})).json()

    async def parse_einvoice(self, file: Union[bytes, bytearray, str], as_: str = "json", lang: Optional[str] = None, content_type: Optional[str] = None) -> Union[Dict[str, Any], EInvoiceFile]:
        content, ctype = _document(file, content_type)
        response = await self._send("POST", "/einvoice/parse", _parse_params(as_, lang), content, {"Content-Type": ctype, "Accept": "application/pdf, application/problem+json" if as_ == "pdf" else "application/json"})
        return EInvoiceFile(response) if as_ == "pdf" else response.json()

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
