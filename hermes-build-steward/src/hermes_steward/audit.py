from __future__ import annotations

from typing import Any


_SECRET_MARKERS = ("secret", "password", "credential", "privatekey", "apikey", "authorization")


def sanitize_audit_value(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized = {}
        for key, item in value.items():
            normalized = str(key).replace("_", "").lower()
            token_secret = normalized == "token" or normalized.endswith(("accesstoken", "refreshtoken", "secrettoken", "bearertoken", "graphtoken", "githubtoken"))
            sanitized[key] = "[REDACTED]" if token_secret or any(marker in normalized for marker in _SECRET_MARKERS) else sanitize_audit_value(item)
        return sanitized
    if isinstance(value, list):
        return [sanitize_audit_value(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_audit_value(item) for item in value]
    return value
