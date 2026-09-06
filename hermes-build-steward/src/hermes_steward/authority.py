from __future__ import annotations


class AuthorityDenied(PermissionError):
    pass


class Phase1Authority:
    """Closed Phase 1 capability envelope; absent capabilities are denied."""

    _ALLOWED = frozenset(
        {
            "read_specification",
            "read_acceptance_contract",
            "inspect_github_evidence",
            "inspect_ci_evidence",
            "write_task_state",
            "run_isolated_verification",
        }
    )

    def require(self, capability: str) -> None:
        if capability not in self._ALLOWED:
            raise AuthorityDenied(f"HERMES-01 Phase 1 authority denied: {capability!r}")
