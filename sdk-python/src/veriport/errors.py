"""The API's RFC 9457 problem documents as exceptions."""
from __future__ import annotations

from typing import Any, Dict, List, Optional


class VeriportError(Exception):
    """A non-2xx answer. ``code`` is the stable problem code (``vies_unavailable``, ``quota_exceeded``, ``rate_limited``…), ``problem`` the whole document."""

    def __init__(self, status: int, problem: Dict[str, Any], meta: Any = None, retry_after: Optional[int] = None) -> None:
        self.status = status
        self.problem = problem
        self.code: str = str(problem.get("code") or f"http_{status}")
        self.detail: str = str(problem.get("detail") or problem.get("title") or "request failed")
        self.meta = meta
        self.retry_after = retry_after
        super().__init__(f"{self.code}: {self.detail}")

    @property
    def feature(self) -> Optional[str]:
        """``einvoice_unsupported``: the first feature the writers refused (``attachments``, ``currency``, ``unknown_field``…)."""
        value = self.problem.get("feature")
        return str(value) if value is not None else None

    @property
    def unsupported(self) -> List[Dict[str, Any]]:
        """``einvoice_unsupported``: every field or value refused, each ``{feature, path, detail}``."""
        return list(self.problem.get("unsupported") or [])

    @property
    def violations(self) -> List[Dict[str, Any]]:
        """``einvoice_invalid``: the rules the invoice breaks, each ``{rule, severity, path, message}``."""
        return list(self.problem.get("violations") or [])

    @property
    def retryable(self) -> bool:
        """True for a rate limit or an upstream (VIES, registry) that did not answer."""
        return self.status in (429, 503)
