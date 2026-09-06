"""Validate EXEC-01 synthetic Hostinger qualification evidence.

This entrypoint does not activate production or execute client material. An authorized
later qualification run supplies the trusted profile manifest and evidence produced by
the Hostinger coordinator, executor gateway, publisher and GitHub readback.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from hermes_steward.execution_contracts import ExecutorProfile


REQUIRED_CHECKS = (
    "codexSyntheticDispatch",
    "claudeSyntheticDispatch",
    "providerCredentialIsolation",
    "controlPlaneCredentialIsolation",
    "networkContainment",
    "scopePathEnforcement",
    "timeoutTermination",
    "crashRecovery",
    "duplicateDispatch",
    "staleFenceDenial",
    "trustedPublisher",
    "normalizedBuildResult",
    "hermesIndependentVerification",
)


def _read(path: str) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain one JSON object")
    return value


def load_profiles(path: str) -> dict[str, ExecutorProfile]:
    raw = _read(path)
    if set(raw) != {"codex", "claude-code"}:
        raise SystemExit("profile manifest must contain exactly codex and claude-code")
    profiles = {}
    for provider, value in raw.items():
        if not isinstance(value, dict):
            raise SystemExit(f"{provider} profile must be an object")
        profile = ExecutorProfile(**value)
        if profile.provider != provider:
            raise SystemExit(f"{provider} profile provider mismatch")
        profiles[provider] = profile
    return profiles


def qualification_plan(profiles: dict[str, ExecutorProfile]) -> dict:
    return {
        "buildId": "EXEC-01",
        "classification": "synthetic-non-client",
        "profiles": {
            provider: {
                "profileId": item.profile_id,
                "profileFingerprint": item.fingerprint,
                "runtimeName": item.runtime_name,
                "runtimeVersion": item.runtime_version,
                "model": item.model,
                "launcherVersion": item.launcher_version,
            }
            for provider, item in sorted(profiles.items())
        },
        "requiredChecks": list(REQUIRED_CHECKS),
        "restrictions": {
            "draftPrOnly": True,
            "merge": False,
            "deployment": False,
            "productionActivation": False,
            "clientDocuments": False,
        },
    }


def verify_evidence(profiles: dict[str, ExecutorProfile], evidence: dict) -> dict:
    if evidence.get("buildId") != "EXEC-01" or evidence.get("classification") != "synthetic-non-client":
        raise SystemExit("qualification evidence must be EXEC-01 synthetic-non-client")
    observed = evidence.get("profileFingerprints")
    expected = {provider: item.fingerprint for provider, item in profiles.items()}
    if observed != expected:
        raise SystemExit("qualification profile fingerprints do not match the approved manifest")
    checks = evidence.get("checks")
    if not isinstance(checks, dict) or set(checks) != set(REQUIRED_CHECKS):
        raise SystemExit("qualification evidence does not contain the exact required checks")
    failed = [name for name in REQUIRED_CHECKS if checks[name] is not True]
    if failed:
        raise SystemExit(f"qualification checks failed: {failed}")
    pull_requests = evidence.get("pullRequests")
    if not isinstance(pull_requests, list) or len(pull_requests) < 2:
        raise SystemExit("qualification requires Codex and Claude synthetic draft PR evidence")
    if any(item.get("isDraft") is not True or item.get("merged") is not False for item in pull_requests):
        raise SystemExit("qualification PRs must remain draft and unmerged")
    if evidence.get("hermesDisposition") not in {"PASS", "FAIL"}:
        raise SystemExit("qualification requires an independently produced Hermes disposition")
    return {"status": "QUALIFIED", "profiles": expected, "checks": checks}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--evidence")
    arguments = parser.parse_args()
    profiles = load_profiles(arguments.profiles)
    value = verify_evidence(profiles, _read(arguments.evidence)) if arguments.evidence else qualification_plan(profiles)
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
