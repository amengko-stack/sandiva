from __future__ import annotations

import importlib.util
import json
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from helpers import build_task, normalized_result
from hermes_steward.config import RuntimeConfig
from hermes_steward.coordinator import Coordinator
from hermes_steward.evidence import (
    GitHubEvidenceReader,
    TrustedEvidence,
    coordinator_observation_evidence,
)
from hermes_steward.results import ResultValidationError, validate_job_result
from hermes_steward.state import TaskStatus
from hermes_steward.store import InMemoryStateStore


def runtime_config() -> RuntimeConfig:
    return RuntimeConfig.from_mapping(
        {
            "environmentKind": "development",
            "runtimeRole": "local-development",
            "environmentId": "hermes-dev-local",
            "taskNamespace": "dev.synthetic",
            "leaseDomain": "dev.local",
            "workerIdentity": "dev-worker-1",
            "hermesVersion": "0.1.0",
            "stateBackend": "memory-test-only",
            "stateEndpoint": "memory://tests",
            "resultMaxBytes": 65536,
        }
    )


def job_evidence(reference: str, criteria: list[str], *, kind: str = "isolated-job-observation") -> dict:
    return {
        "evidenceRef": reference,
        "kind": kind,
        "source": "isolated-job://attempt-1/stdout",
        "result": "PASS",
        "criteria": criteria,
        "details": {"exitCode": 0},
    }


def candidate_with_evidence(task, lease, evidence: list[dict], criterion_refs: dict[str, list[str]]) -> dict:
    value = normalized_result(task, lease)
    value["deterministicEvidence"] = evidence
    value["semanticEvidence"] = []
    value["acceptanceCriteriaResults"] = [
        {"criterion": criterion, "result": "PASS", "evidenceRefs": criterion_refs[criterion]}
        for criterion in task["acceptanceCriteria"]
    ]
    return value


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, headers, body=None):
        self.calls.append((method, url, dict(headers), body))
        return self.responses.pop(0)


class EvidenceForgeryRegressionTests(unittest.TestCase):
    def setUp(self):
        self.task = build_task()
        self.lease = SimpleNamespace(
            attempt_id="attempt-1", worker_id="worker-1", lease_id="lease-1", fencing_token=3
        )

    def validate(self, candidate):
        return validate_job_result(json.dumps(candidate).encode(), self.task, self.lease, 65536)

    def test_f1_dangling_evidence_reference_is_rejected(self):
        evidence = job_evidence("job://actual", self.task["acceptanceCriteria"])
        candidate = candidate_with_evidence(
            self.task,
            self.lease,
            [evidence],
            {criterion: ["forged://missing"] for criterion in self.task["acceptanceCriteria"]},
        )
        with self.assertRaisesRegex(ResultValidationError, "unknown evidence reference"):
            self.validate(candidate)

    def test_f2_untrusted_job_cannot_fabricate_github_ci_evidence(self):
        forged = job_evidence(
            "github-ci://amengko-stack/sandiva/commit/" + "a" * 40,
            self.task["acceptanceCriteria"],
            kind="github-ci",
        )
        candidate = candidate_with_evidence(
            self.task,
            self.lease,
            [forged],
            {criterion: [forged["evidenceRef"]] for criterion in self.task["acceptanceCriteria"]},
        )
        with self.assertRaisesRegex(ResultValidationError, "untrusted job evidence kind"):
            self.validate(candidate)

    def test_untrusted_job_cannot_supply_semantic_evidence(self):
        evidence = job_evidence("job://semantic", self.task["acceptanceCriteria"])
        evidence["result"] = "FAIL"
        candidate = candidate_with_evidence(
            self.task,
            self.lease,
            [],
            {criterion: ["job://semantic"] for criterion in self.task["acceptanceCriteria"]},
        )
        candidate["semanticEvidence"] = [evidence]
        candidate["result"] = "FAIL"
        for criterion in candidate["acceptanceCriteriaResults"]:
            criterion["result"] = "FAIL"
        with self.assertRaisesRegex(ResultValidationError, "semantic evidence"):
            self.validate(candidate)

    def test_trusted_origin_must_authorize_the_evidence_kind(self):
        acquired = coordinator_observation_evidence(
            evidence_ref="audit://synthetic/check",
            kind="coordinator-observation",
            source="audit://synthetic",
            result="PASS",
            criteria=self.task["acceptanceCriteria"],
            details={},
        )
        forged = replace(acquired, kind="github-ci")
        candidate = normalized_result(self.task, self.lease)
        candidate["deterministicEvidence"] = []
        candidate["acceptanceCriteriaResults"] = [
            {"criterion": criterion, "result": "PASS", "evidenceRefs": [forged.evidence_ref]}
            for criterion in self.task["acceptanceCriteria"]
        ]
        with self.assertRaisesRegex(ResultValidationError, "does not authorize evidence kind"):
            validate_job_result(
                json.dumps(candidate).encode(), self.task, self.lease, 65536, trusted_evidence=[forged]
            )

    def test_trusted_evidence_object_without_acquisition_proof_is_rejected(self):
        forged = TrustedEvidence(
            category="deterministic",
            evidence_ref="github-ci://forged",
            kind="github-ci",
            source="https://api.github.com/forged",
            result="PASS",
            trusted_origin="TRUSTED_EXTERNAL_SYSTEM",
            criteria=tuple(self.task["acceptanceCriteria"]),
            details={},
        )
        candidate = normalized_result(self.task, self.lease)
        candidate["deterministicEvidence"] = []
        candidate["acceptanceCriteriaResults"] = [
            {"criterion": criterion, "result": "PASS", "evidenceRefs": [forged.evidence_ref]}
            for criterion in self.task["acceptanceCriteria"]
        ]
        with self.assertRaisesRegex(ResultValidationError, "acquisition path"):
            validate_job_result(
                json.dumps(candidate).encode(), self.task, self.lease, 65536, trusted_evidence=[forged]
            )

    def test_f3_duplicate_evidence_identity_is_rejected(self):
        first = job_evidence("job://duplicate", self.task["acceptanceCriteria"])
        second = job_evidence("job://duplicate", self.task["acceptanceCriteria"])
        second["details"] = {"exitCode": 1}
        candidate = candidate_with_evidence(
            self.task,
            self.lease,
            [first, second],
            {criterion: ["job://duplicate"] for criterion in self.task["acceptanceCriteria"]},
        )
        with self.assertRaisesRegex(ResultValidationError, "duplicate evidence identity"):
            self.validate(candidate)

    def test_f4_criterion_cannot_use_evidence_for_another_check(self):
        evidence = job_evidence("job://only-a1", ["AC-A1"])
        candidate = candidate_with_evidence(
            self.task,
            self.lease,
            [evidence],
            {"AC-01": ["job://only-a1"], "AC-A1": ["job://only-a1"]},
        )
        with self.assertRaisesRegex(ResultValidationError, "does not prove criterion AC-01"):
            self.validate(candidate)

    def test_f5_vm_qualification_cannot_blanket_pass_an_unevaluated_criterion(self):
        script_path = Path(__file__).parents[1] / "qualification" / "run_vm_qualification.py"
        spec = importlib.util.spec_from_file_location("run_vm_qualification", script_path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        task = build_task(acceptanceCriteria=["VMQ-NORMAL-VERIFICATION", "AC-UNTESTED"])
        evidence = job_evidence("job://normal", ["VMQ-NORMAL-VERIFICATION"])
        with self.assertRaisesRegex(ValueError, "not explicitly evaluated"):
            module.result_candidate(
                task,
                self.lease,
                [evidence],
                {"VMQ-NORMAL-VERIFICATION": ["job://normal"]},
            )

    def test_f6_legitimate_isolated_job_evidence_is_accepted_and_origin_stamped(self):
        evidence = job_evidence("job://normal", self.task["acceptanceCriteria"])
        candidate = candidate_with_evidence(
            self.task,
            self.lease,
            [evidence],
            {criterion: ["job://normal"] for criterion in self.task["acceptanceCriteria"]},
        )
        validated = self.validate(candidate)
        self.assertEqual(validated["deterministicEvidence"][0]["trustedOrigin"], "ISOLATED_VERIFICATION_JOB")

    def test_f7_coordinator_retrieved_github_ci_evidence_can_prove_its_criterion(self):
        sha = "c59596559515efa6e088eff4024f90cdca5b3898"
        task = build_task(acceptanceCriteria=["AC-CI"], commitRefs=[sha])
        coordinator = Coordinator(InMemoryStateStore(), runtime_config())
        coordinator.submit_task(task)
        lease = coordinator.claim(task["taskId"], 1, "worker-1", 30)
        coordinator.begin_verification(task["taskId"], 1, lease.lease_id, lease.fencing_token)
        transport = FakeTransport(
            [
                (200, {}, json.dumps({"sha": sha, "html_url": f"https://github.com/commit/{sha}"}).encode()),
                (
                    200,
                    {},
                    json.dumps(
                        {
                            "check_runs": [
                                {"id": 17, "name": "Hermes", "conclusion": "success", "head_sha": sha}
                            ]
                        }
                    ).encode(),
                ),
            ]
        )
        evidence = coordinator.retrieve_github_ci_evidence(
            task["taskId"],
            1,
            lease.lease_id,
            lease.fencing_token,
            sha,
            ["AC-CI"],
            GitHubEvidenceReader(transport=transport),
        )
        candidate = normalized_result(task, lease)
        candidate["deterministicEvidence"] = []
        candidate["semanticEvidence"] = []
        candidate["acceptanceCriteriaResults"] = [
            {"criterion": "AC-CI", "result": "PASS", "evidenceRefs": [evidence.evidence_ref]}
        ]
        record = coordinator.complete_attempt(
            task["taskId"],
            1,
            candidate,
            lease.lease_id,
            lease.fencing_token,
            trusted_evidence=[evidence],
        )
        self.assertEqual(record.status, TaskStatus.READY_FOR_PM_ACCEPTANCE)
        self.assertEqual(record.results[-1]["deterministicEvidence"][0]["kind"], "github-ci")
        self.assertEqual(
            record.results[-1]["deterministicEvidence"][0]["trustedOrigin"], "TRUSTED_EXTERNAL_SYSTEM"
        )
        self.assertTrue(all(call[0] == "GET" for call in transport.calls))


if __name__ == "__main__":
    unittest.main()
