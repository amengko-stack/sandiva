#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os

from hermes_steward.execution_gateway_service import (
    BoundProviderProxy, GatewayApplication, GatewayPolicy, GatewaySessionCodec,
    MultiProfileGatewayApplication, serve_multi,
)


def applications(codec):
    manifest=json.loads(os.environ["EXEC01_PROFILE_MANIFEST"])
    result={}
    for profile_fingerprint,value in manifest.items():
        configured=GatewayPolicy(provider=value["provider"],model=value["model"],profile_id=value["profileId"],profile_fingerprint=profile_fingerprint,policy_fingerprint=value["policyFingerprint"],implementation_digest=value["implementationDigest"],upstream_url=value["upstreamUrl"])
        credential_name="OPENAI_API_KEY" if configured.provider=="codex" else "ANTHROPIC_API_KEY"
        result[profile_fingerprint]=GatewayApplication(configured,codec,BoundProviderProxy(configured,lambda name=credential_name:os.environ.get(name,"")))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("serve", "health", "issue"))
    parser.add_argument("--task-fingerprint")
    parser.add_argument("--attempt-id")
    parser.add_argument("--profile-fingerprint")
    args = parser.parse_args()
    key = os.environ["EXEC01_SESSION_SIGNING_KEY"].encode()
    codec = GatewaySessionCodec(key)
    gateway=MultiProfileGatewayApplication(applications(codec),codec)
    if args.command == "health": print(json.dumps(gateway.health())); return 0
    if args.command == "issue":
        if not args.task_fingerprint or not args.attempt_id or not args.profile_fingerprint: raise SystemExit("issue identity required")
        print(gateway.issue(profile_fingerprint=args.profile_fingerprint,task_fingerprint=args.task_fingerprint,attempt_id=args.attempt_id)); return 0
    serve_multi(gateway)
    return 0


if __name__ == "__main__": raise SystemExit(main())
