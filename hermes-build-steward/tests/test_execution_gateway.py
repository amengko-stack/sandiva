from __future__ import annotations

import json
import unittest

from hermes_steward.execution_gateway import (
    ClaudeGatewayBackend,
    CodexGatewayBackend,
    ExecutorGatewayDenied,
    TrustedExecutorGateway,
    gateway_request,
)
from test_execution_adapters import profile, request_for


class ExecutorGatewayTests(unittest.TestCase):
    def test_one_shot_provider_api_objects_are_not_treated_as_build_executions(self):
        """The reviewed CLI proxy path replaces the incoherent one-shot API path."""
        class Transport:
            def request(self, url, headers, body, timeout_seconds):
                raise AssertionError("one-shot provider HTTP transport must not be invoked")

        for provider, backend_type in (
            ("codex", CodexGatewayBackend),
            ("claude-code", ClaudeGatewayBackend),
        ):
            executor_profile = profile(provider)
            request = request_for(executor_profile)
            with self.assertRaisesRegex(ExecutorGatewayDenied, "not software-build executions"):
                backend_type(transport=Transport()).execute(
                    executor_profile, request, f"{provider}-SECRET", 7
                )

    def test_bound_gateway_keeps_raw_credential_and_profile_authority_on_trusted_side(self):
        """Catches a gateway that accepts caller-controlled provider/model/authority fields."""
        executor_profile = profile("codex")
        request = request_for(executor_profile)

        class Provider:
            def execute(self, observed_profile, observed_request, credential, timeout_seconds):
                self.observed = (observed_profile, observed_request, credential, timeout_seconds)
                return {"status": "completed"}

        provider = Provider()
        gateway = TrustedExecutorGateway(
            executor_profile,
            request,
            provider,
            credential_provider=lambda: "OPENAI-SENTINEL",
            timeout_seconds=2,
            response_limit_bytes=1024,
        )

        response = gateway.execute(gateway_request(request, executor_profile))

        self.assertEqual(response["providerResult"], {"status": "completed"})
        self.assertEqual(response["attemptId"], request.attempt_id)
        self.assertEqual(provider.observed[2], "OPENAI-SENTINEL")
        self.assertNotIn("SENTINEL", json.dumps(response))
        self.assertNotIn("SENTINEL", json.dumps(gateway.audit_records))

        for label, mutation in (
            ("cross task", {"taskId": "OTHER"}),
            ("profile swap", {"profileId": "claude-hostinger-v1"}),
            ("model injection", {"model": "attacker-model"}),
            ("authority widening", {"permissionEnvelopeRef": "allow-all"}),
        ):
            candidate = {**gateway_request(request, executor_profile), **mutation}
            with self.subTest(label=label), self.assertRaises(ExecutorGatewayDenied):
                TrustedExecutorGateway(
                    executor_profile, request, provider,
                    credential_provider=lambda: "OPENAI-SENTINEL",
                    timeout_seconds=2, response_limit_bytes=1024,
                ).execute(candidate)

    def test_gateway_is_single_use_and_response_size_bounded(self):
        """Catches replay and an unbounded provider response."""
        executor_profile = profile("claude-code")
        request = request_for(executor_profile)

        class Provider:
            def execute(self, *args):
                del args
                return {"payload": "x" * 2048}

        gateway = TrustedExecutorGateway(
            executor_profile, request, Provider(), credential_provider=lambda: "ANTHROPIC-SENTINEL",
            timeout_seconds=2, response_limit_bytes=256,
        )
        with self.assertRaisesRegex(ExecutorGatewayDenied, "size"):
            gateway.execute(gateway_request(request, executor_profile))
        with self.assertRaisesRegex(ExecutorGatewayDenied, "replay"):
            gateway.execute(gateway_request(request, executor_profile))

    def test_gateway_denies_provider_response_that_reflects_its_raw_credential(self):
        """Catches an upstream response accidentally returning the gateway-held provider secret."""
        executor_profile = profile("codex")
        request = request_for(executor_profile)

        class Provider:
            def execute(self, *args):
                return {"echo": args[2]}

        gateway = TrustedExecutorGateway(
            executor_profile, request, Provider(), credential_provider=lambda: "OPENAI-SENTINEL",
            timeout_seconds=2, response_limit_bytes=1024,
        )
        with self.assertRaisesRegex(ExecutorGatewayDenied, "reflected credential"):
            gateway.execute(gateway_request(request, executor_profile))
        self.assertNotIn("OPENAI-SENTINEL", json.dumps(gateway.audit_records))


if __name__ == "__main__":
    unittest.main()
