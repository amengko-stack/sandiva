from __future__ import annotations

from datetime import datetime, timezone


SPEC_BYTES = b"canonical specification\n"
AC_BYTES = b"canonical acceptance contract\n"


def sha256_hex(value: bytes) -> str:
    import hashlib

    return hashlib.sha256(value).hexdigest()


def build_task(**overrides):
    now = datetime(2026, 9, 5, 8, 0, tzinfo=timezone.utc).isoformat()
    task = {
        "schemaVersion": "1.0",
        "taskId": "HERMES-01-SYNTHETIC-001",
        "taskVersion": 1,
        "originatingPmInstructionRef": "sharepoint://pm/HERMES-01-SYNTHETIC-001",
        "originatingPmInstructionFingerprint": "1" * 64,
        "specificationRef": "sharepoint://spec/HERMES-01-v1",
        "specificationVersion": "v1",
        "specificationHash": sha256_hex(SPEC_BYTES),
        "acceptanceContractRef": "sharepoint://acceptance/HERMES-01-v1",
        "acceptanceContractVersion": "v1",
        "acceptanceContractHash": sha256_hex(AC_BYTES),
        "repository": "https://github.com/amengko-stack/sandiva",
        "baseRef": "c59596559515efa6e088eff4024f90cdca5b3898",
        "scope": ["hermes-build-steward/**"],
        "acceptanceCriteria": ["AC-01", "AC-A1"],
        "permittedRepositoryAreas": ["hermes-build-steward/**", ".github/workflows/hermes-build-steward.yml"],
        "prohibitedRepositoryAreas": ["sln-litigation-drafter/**", "client/**", "server/**"],
        "riskLevel": "P0",
        "executorPolicy": {"automaticDispatch": False, "approvedCommands": ["python -m unittest"]},
        "executionStatus": "CREATED",
        "branchRef": None,
        "prRef": None,
        "commitRefs": [],
        "evaluationRequirements": ["unit", "integration", "isolation"],
        "qaRequirements": ["independent QA", "VM qualification"],
        "partnerGateStatus": "NOT_REQUIRED",
        "retryPolicy": {"maxAttempts": 3, "backoffSeconds": 30},
        "attemptCount": 0,
        "failureHistory": [],
        "permissionEnvelopeRef": "sharepoint://permissions/hermes-phase1",
        "provenance": {"buildId": "HERMES-01", "createdBy": "PM"},
        "auditMetadata": {"classification": "synthetic-non-client"},
        "createdAt": now,
        "updatedAt": now,
    }
    task.update(overrides)
    return task


def normalized_result(task, lease, result="PASS", **overrides):
    now = datetime(2026, 9, 5, 8, 1, tzinfo=timezone.utc).isoformat()
    evidence_reference = "isolated-job://synthetic/attempt-1/unit"
    value = {
        "schemaVersion": "1.0",
        "taskId": task["taskId"],
        "attemptId": lease.attempt_id,
        "HermesVersion": "0.1.0",
        "configFingerprint": "2" * 64,
        "workerIdentity": lease.worker_id,
        "leaseId": lease.lease_id,
        "fencingToken": lease.fencing_token,
        "specificationRef": task["specificationRef"],
        "specificationHash": task["specificationHash"],
        "acceptanceContractRef": task["acceptanceContractRef"],
        "acceptanceContractHash": task["acceptanceContractHash"],
        "repository": task["repository"],
        "baseRef": task["baseRef"],
        "branchRef": task["branchRef"],
        "prRef": task["prRef"],
        "commitRefs": task["commitRefs"],
        "deterministicEvidence": [
            {
                "evidenceRef": evidence_reference,
                "kind": "isolated-job-observation",
                "source": "isolated-job://synthetic/attempt-1/stdout",
                "result": result,
                "criteria": list(task["acceptanceCriteria"]),
                "details": {"check": "unit", "exitCode": 0 if result == "PASS" else 1},
            }
        ],
        "semanticEvidence": [],
        "acceptanceCriteriaResults": [
            {"criterion": criterion, "result": result, "evidenceRefs": [evidence_reference]}
            for criterion in task["acceptanceCriteria"]
        ],
        "result": result,
        "residualRisks": [],
        "retryInformation": {"eligible": result == "FAIL", "attempt": 1},
        "timestamps": {"startedAt": now, "completedAt": now},
        "auditReferences": ["audit://synthetic/1"],
    }
    value.update(overrides)
    return value
