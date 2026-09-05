from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from helpers import build_task, normalized_result
from hermes_steward.config import RuntimeConfig
from hermes_steward.contracts import ContractValidationError, validate_build_task
from hermes_steward.coordinator import Coordinator, CoordinatorError
from hermes_steward.evidence import (
    GitHubEvidenceReader,
    coordinator_observation_evidence,
)
from hermes_steward.results import ResultValidationError, validate_job_result
from hermes_steward.store import InMemoryStateStore


def policy(*pairs: tuple[str, str]) -> dict:
    return {
        "allowedEvidence": [
            {"origin": origin, "kind": kind}
            for origin, kind in pairs
        ]
    }


def task_with_policy(criterion: str, *pairs: tuple[str, str], **overrides) -> dict:
    return build_task(
        acceptanceCriteria=[criterion],
        criterionEvidencePolicy={criterion: policy(*pairs)},
        **overrides,
    )


def job_evidence(criterion: str, reference: str = "isolated-job://attempt-1/check") -> dict:
    return {
        "evidenceRef": reference,
        "kind": "isolated-job-observation",
        "source": "isolated-job://attempt-1/stdout",
        "result": "PASS",
        "criteria": [criterion],
        "details": {"exitCode": 0},
    }


def candidate(task: dict, lease, references: list[str], evidence: list[dict] | None = None) -> dict:
    value = normalized_result(task, lease)
    value["deterministicEvidence"] = list(evidence or [])
    value["semanticEvidence"] = []
    value["acceptanceCriteriaResults"] = [
        {"criterion": task["acceptanceCriteria"][0], "result": "PASS", "evidenceRefs": references}
    ]
    return value


class FakeTransport:
    def __init__(self, sha: str):
        self.responses = [
            (200, {}, json.dumps({"sha": sha, "html_url": f"https://github.com/commit/{sha}"}).encode()),
            (
                200,
                {},
                json.dumps(
                    {
                        "check_runs": [
                            {"id": 23, "name": "Hermes", "conclusion": "success", "head_sha": sha}
                        ]
                    }
                ).encode(),
            ),
        ]

    def request(self, method, url, headers, body=None):
        if method != "GET" or body is not None:
            raise AssertionError("trusted GitHub evidence must use immutable GET requests")
        return self.responses.pop(0)


class RejectingTransport:
    def request(self, method, url, headers, body=None):
        raise AssertionError("unauthorized criterion must fail before external retrieval")


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


class CriterionEvidenceAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.lease = SimpleNamespace(
            attempt_id="attempt-1", worker_id="worker-1", lease_id="lease-1", fencing_token=7
        )

    def validate(self, task: dict, value: dict, trusted_evidence=()):
        return validate_job_result(
            json.dumps(value).encode(),
            task,
            self.lease,
            65536,
            trusted_evidence=trusted_evidence,
        )

    def test_g1_job_cannot_self_vouch_for_coordinator_only_criterion(self):
        task = task_with_policy("AC-RUNTIME", ("TRUSTED_COORDINATOR", "runtime-state"))
        evidence = job_evidence("AC-RUNTIME")
        with self.assertRaisesRegex(ResultValidationError, "not authorized by criterion evidence policy"):
            self.validate(task, candidate(task, self.lease, [evidence["evidenceRef"]], [evidence]))

    def test_g2_job_cannot_self_vouch_for_ci_only_criterion(self):
        task = task_with_policy("AC-CI", ("TRUSTED_EXTERNAL_SYSTEM", "github-ci"))
        evidence = job_evidence("AC-CI")
        with self.assertRaisesRegex(ResultValidationError, "not authorized by criterion evidence policy"):
            self.validate(task, candidate(task, self.lease, [evidence["evidenceRef"]], [evidence]))

    def test_g3_matching_coordinator_evidence_is_accepted(self):
        task = task_with_policy("AC-RUNTIME", ("TRUSTED_COORDINATOR", "runtime-state"))
        evidence = coordinator_observation_evidence(
            evidence_ref="audit://task/runtime",
            kind="runtime-state",
            source="audit://task/runtime",
            result="PASS",
            criteria=["AC-RUNTIME"],
            details={"environment": "synthetic"},
        )
        value = candidate(task, self.lease, [evidence.evidence_ref])
        validated = self.validate(task, value, [evidence])
        self.assertEqual(validated["deterministicEvidence"][0]["trustedOrigin"], "TRUSTED_COORDINATOR")

    def test_g4_matching_coordinator_acquired_ci_evidence_is_accepted(self):
        sha = "c59596559515efa6e088eff4024f90cdca5b3898"
        task = task_with_policy(
            "AC-CI",
            ("TRUSTED_EXTERNAL_SYSTEM", "github-ci"),
            commitRefs=[sha],
        )
        from hermes_steward.evidence import retrieve_github_ci_evidence

        evidence = retrieve_github_ci_evidence(
            GitHubEvidenceReader(transport=FakeTransport(sha)),
            task["repository"],
            sha,
            ["AC-CI"],
        )
        value = candidate(task, self.lease, [evidence.evidence_ref])
        validated = self.validate(task, value, [evidence])
        self.assertEqual(validated["deterministicEvidence"][0]["trustedOrigin"], "TRUSTED_EXTERNAL_SYSTEM")

    def test_g5_explicitly_allowed_isolated_job_criterion_is_accepted(self):
        task = task_with_policy(
            "AC-JOB",
            ("ISOLATED_VERIFICATION_JOB", "isolated-job-observation"),
        )
        evidence = job_evidence("AC-JOB")
        validated = self.validate(
            task,
            candidate(task, self.lease, [evidence["evidenceRef"]], [evidence]),
        )
        self.assertEqual(validated["deterministicEvidence"][0]["trustedOrigin"], "ISOLATED_VERIFICATION_JOB")

    def test_g6_task_criterion_missing_policy_is_rejected(self):
        task = build_task()
        del task["criterionEvidencePolicy"]["AC-A1"]
        with self.assertRaisesRegex(
            ContractValidationError,
            "criterionEvidencePolicy must cover every acceptance criterion exactly once",
        ):
            validate_build_task(task)

    def test_g7_policy_unknown_criterion_is_rejected(self):
        task = build_task()
        task["criterionEvidencePolicy"]["AC-UNKNOWN"] = policy(
            ("ISOLATED_VERIFICATION_JOB", "isolated-job-observation")
        )
        with self.assertRaisesRegex(
            ContractValidationError,
            "criterionEvidencePolicy must cover every acceptance criterion exactly once",
        ):
            validate_build_task(task)

    def test_g8_globally_valid_origin_with_wrong_policy_kind_is_rejected(self):
        task = task_with_policy("AC-RUNTIME", ("TRUSTED_COORDINATOR", "runtime-state"))
        evidence = coordinator_observation_evidence(
            evidence_ref="audit://task/observation",
            kind="coordinator-observation",
            source="audit://task/observation",
            result="PASS",
            criteria=["AC-RUNTIME"],
            details={},
        )
        with self.assertRaisesRegex(ResultValidationError, "not authorized by criterion evidence policy"):
            self.validate(task, candidate(task, self.lease, [evidence.evidence_ref]), [evidence])

    def test_g9_multiple_pairs_allow_only_the_explicit_combinations(self):
        task = task_with_policy(
            "AC-MIXED",
            ("ISOLATED_VERIFICATION_JOB", "isolated-job-observation"),
            ("TRUSTED_COORDINATOR", "runtime-state"),
        )
        job = job_evidence("AC-MIXED", "isolated-job://attempt-1/mixed")
        runtime = coordinator_observation_evidence(
            evidence_ref="audit://task/mixed-runtime",
            kind="runtime-state",
            source="audit://task/mixed-runtime",
            result="PASS",
            criteria=["AC-MIXED"],
            details={},
        )
        accepted = candidate(
            task,
            self.lease,
            [job["evidenceRef"], runtime.evidence_ref],
            [job],
        )
        self.validate(task, accepted, [runtime])

        unlisted = coordinator_observation_evidence(
            evidence_ref="audit://task/mixed-observation",
            kind="coordinator-observation",
            source="audit://task/mixed-observation",
            result="PASS",
            criteria=["AC-MIXED"],
            details={},
        )
        rejected = candidate(task, self.lease, [unlisted.evidence_ref])
        with self.assertRaisesRegex(ResultValidationError, "not authorized by criterion evidence policy"):
            self.validate(task, rejected, [unlisted])

    def test_policy_is_bound_to_task_fingerprint_and_cannot_change_on_duplicate_delivery(self):
        task = build_task()
        coordinator = Coordinator(InMemoryStateStore(), runtime_config())
        coordinator.submit_task(task)
        changed = copy.deepcopy(task)
        changed["criterionEvidencePolicy"]["AC-01"] = policy(
            ("TRUSTED_COORDINATOR", "runtime-state")
        )
        with self.assertRaisesRegex(CoordinatorError, "conflicting duplicate"):
            coordinator.submit_task(changed)

    def test_ci_retrieval_rejects_criterion_not_authorized_for_github_before_external_call(self):
        sha = "c59596559515efa6e088eff4024f90cdca5b3898"
        task = task_with_policy(
            "AC-JOB",
            ("ISOLATED_VERIFICATION_JOB", "isolated-job-observation"),
            commitRefs=[sha],
        )
        coordinator = Coordinator(InMemoryStateStore(), runtime_config())
        coordinator.submit_task(task)
        lease = coordinator.claim(task["taskId"], 1, "worker-1", 30)
        coordinator.begin_verification(task["taskId"], 1, lease.lease_id, lease.fencing_token)
        with self.assertRaisesRegex(CoordinatorError, "criterion evidence policy"):
            coordinator.retrieve_github_ci_evidence(
                task["taskId"],
                1,
                lease.lease_id,
                lease.fencing_token,
                sha,
                ["AC-JOB"],
                GitHubEvidenceReader(transport=RejectingTransport()),
            )

    def test_vm_qualification_rejects_job_authority_for_coordinator_only_check(self):
        script_path = Path(__file__).parents[1] / "qualification" / "run_vm_qualification.py"
        spec = importlib.util.spec_from_file_location("authority_policy_vm_qualification", script_path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        task = build_task(
            acceptanceCriteria=list(module.QUALIFICATION_CRITERIA),
            criterionEvidencePolicy=copy.deepcopy(module.QUALIFICATION_EVIDENCE_POLICY),
            executorPolicy={
                "automaticDispatch": False,
                "approvedCommands": ["python runaway.py", "python probe.py"],
            },
        )
        task["criterionEvidencePolicy"]["VMQ-RUNAWAY-TERMINATION"] = policy(
            ("ISOLATED_VERIFICATION_JOB", "isolated-job-observation")
        )
        with self.assertRaisesRegex(SystemExit, "exact trusted evidence-authority policy"):
            module.validate_qualification_task(task)


if __name__ == "__main__":
    unittest.main()
