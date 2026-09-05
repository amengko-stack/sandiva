"""Two-phase synthetic VM qualification. Run only on the authoritative Hermes VM."""
from __future__ import annotations

import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from hermes_steward.cli import _production_coordinator, _read_json
from hermes_steward.contracts import validate_build_task, validate_reference_hashes
from hermes_steward.evidence import TrustedEvidence, coordinator_observation_evidence
from hermes_steward.isolation import BoundedProcessRunner, IsolationPolicy
from hermes_steward.state import TaskStatus


QUALIFICATION_CRITERIA = (
    "VMQ-RUNAWAY-TERMINATION",
    "VMQ-CONTAINER-CLEANUP",
    "VMQ-RESTART-RECOVERY",
    "VMQ-LEASE-FENCING",
    "VMQ-SECRET-ISOLATION",
    "VMQ-FILESYSTEM-ISOLATION",
    "VMQ-NETWORK-ISOLATION",
    "VMQ-NORMAL-VERIFICATION",
    "VMQ-DURABLE-STATE-RECOVERY",
)

QUALIFICATION_EVIDENCE_POLICY = {
    "VMQ-RUNAWAY-TERMINATION": {
        "allowedEvidence": [{"origin": "TRUSTED_COORDINATOR", "kind": "coordinator-observation"}]
    },
    "VMQ-CONTAINER-CLEANUP": {
        "allowedEvidence": [{"origin": "TRUSTED_COORDINATOR", "kind": "coordinator-observation"}]
    },
    "VMQ-RESTART-RECOVERY": {
        "allowedEvidence": [{"origin": "TRUSTED_COORDINATOR", "kind": "runtime-state"}]
    },
    "VMQ-LEASE-FENCING": {
        "allowedEvidence": [{"origin": "TRUSTED_COORDINATOR", "kind": "lease-fencing"}]
    },
    "VMQ-DURABLE-STATE-RECOVERY": {
        "allowedEvidence": [{"origin": "TRUSTED_COORDINATOR", "kind": "coordinator-audit"}]
    },
    "VMQ-SECRET-ISOLATION": {
        "allowedEvidence": [{"origin": "ISOLATED_VERIFICATION_JOB", "kind": "isolated-job-observation"}]
    },
    "VMQ-FILESYSTEM-ISOLATION": {
        "allowedEvidence": [{"origin": "ISOLATED_VERIFICATION_JOB", "kind": "isolated-job-observation"}]
    },
    "VMQ-NETWORK-ISOLATION": {
        "allowedEvidence": [{"origin": "ISOLATED_VERIFICATION_JOB", "kind": "isolated-job-observation"}]
    },
    "VMQ-NORMAL-VERIFICATION": {
        "allowedEvidence": [{"origin": "ISOLATED_VERIFICATION_JOB", "kind": "isolated-job-observation"}]
    },
}


def policy(image: str, timeout: int) -> IsolationPolicy:
    return IsolationPolicy(
        image=image, cpu_limit="1.0", memory_limit="512m", pids_limit=128,
        tmpfs_size="256m", timeout_seconds=timeout, output_limit_bytes=65536,
    )


def validate_qualification_task(task: dict) -> None:
    if task["auditMetadata"].get("classification") != "synthetic-non-client":
        raise SystemExit("qualification refuses any task not marked synthetic-non-client")
    if len(task["acceptanceCriteria"]) != len(QUALIFICATION_CRITERIA) or set(task["acceptanceCriteria"]) != set(QUALIFICATION_CRITERIA):
        raise SystemExit("qualification requires a dedicated task containing only the exact VM qualification criteria")
    if task["criterionEvidencePolicy"] != QUALIFICATION_EVIDENCE_POLICY:
        raise SystemExit("qualification requires the exact trusted evidence-authority policy")


def load_task(arguments):
    task = validate_build_task(_read_json(arguments.task))
    validate_qualification_task(task)
    specification = Path(arguments.specification).read_bytes()
    acceptance = Path(arguments.acceptance_contract).read_bytes()
    validate_reference_hashes(task, specification, acceptance)
    return task, specification, acceptance


def prepare(arguments) -> int:
    task, specification, acceptance = load_task(arguments)
    coordinator = _production_coordinator(arguments.config, arguments.managed_identity_client_id)
    coordinator.submit_task(task, specification, acceptance)
    lease = coordinator.claim(task["taskId"], task["taskVersion"], coordinator.config.worker_identity, 5)
    coordinator.begin_verification(task["taskId"], task["taskVersion"], lease.lease_id, lease.fencing_token)
    runner = BoundedProcessRunner(policy(arguments.image, 1))
    with tempfile.TemporaryDirectory(prefix="hermes-synthetic-input-") as workspace:
        Path(workspace, "runaway.py").write_text("while True: pass\n", encoding="utf-8")
        result = runner.run_verification(task, workspace, ["python", "runaway.py"])
    checks = {
        "VMQ-RUNAWAY-TERMINATION": result.terminated,
        "VMQ-CONTAINER-CLEANUP": result.container_cleanup in {"REMOVED", "ALREADY_REMOVED"},
    }
    coordinator.record_qualification_checkpoint(
        task["taskId"], task["taskVersion"], lease.lease_id, lease.fencing_token, checks
    )
    evidence = {
        "phase": "prepare", "taskId": task["taskId"], "attemptId": lease.attempt_id,
        "leaseId": lease.lease_id, "fencingToken": lease.fencing_token,
        "jobTerminated": result.terminated, "terminationReason": result.termination_reason,
        "containerCleanup": result.container_cleanup,
        "next": "restart the coordinator/service, wait for lease expiry, then run recover",
    }
    print(json.dumps(evidence, sort_keys=True), flush=True)
    if not result.terminated or result.container_cleanup not in {"REMOVED", "ALREADY_REMOVED"}:
        return 1
    os._exit(42)


def result_candidate(
    task,
    lease,
    job_evidence: list[dict],
    criterion_evidence: dict[str, list[str]],
    trusted_evidence: tuple[TrustedEvidence, ...] | list[TrustedEvidence] = (),
):
    expected_criteria = set(task["acceptanceCriteria"])
    if set(criterion_evidence) != expected_criteria:
        missing = sorted(expected_criteria - set(criterion_evidence))
        extra = sorted(set(criterion_evidence) - expected_criteria)
        raise ValueError(f"qualification criteria were not explicitly evaluated; missing={missing} extra={extra}")
    evidence_by_ref = {item["evidenceRef"]: item for item in job_evidence}
    evidence_by_ref.update({item.evidence_ref: item.as_record() for item in trusted_evidence})
    criteria_results = []
    for criterion in task["acceptanceCriteria"]:
        references = criterion_evidence[criterion]
        if not references:
            raise ValueError(f"criterion {criterion} was not explicitly evaluated")
        resolved = []
        for reference in references:
            evidence = evidence_by_ref.get(reference)
            if evidence is None or criterion not in evidence["criteria"]:
                raise ValueError(f"criterion {criterion} was not explicitly evaluated by {reference}")
            resolved.append(evidence)
        disposition = "FAIL" if any(item["result"] == "FAIL" for item in resolved) else "PASS"
        criteria_results.append({"criterion": criterion, "result": disposition, "evidenceRefs": list(references)})
    overall = "FAIL" if any(item["result"] == "FAIL" for item in criteria_results) else "PASS"
    now = datetime.now(timezone.utc).isoformat()
    return {
        "schemaVersion": "1.0", "taskId": task["taskId"], "attemptId": lease.attempt_id,
        "HermesVersion": "coordinator-stamped", "configFingerprint": "0" * 64,
        "workerIdentity": lease.worker_id, "leaseId": lease.lease_id, "fencingToken": lease.fencing_token,
        "specificationRef": task["specificationRef"], "specificationHash": task["specificationHash"],
        "acceptanceContractRef": task["acceptanceContractRef"], "acceptanceContractHash": task["acceptanceContractHash"],
        "repository": task["repository"], "baseRef": task["baseRef"], "branchRef": task["branchRef"],
        "prRef": task["prRef"], "commitRefs": task["commitRefs"],
        "deterministicEvidence": list(job_evidence), "semanticEvidence": [],
        "acceptanceCriteriaResults": criteria_results,
        "result": overall, "residualRisks": ["independent QA remains required"],
        "retryInformation": {"eligible": False}, "timestamps": {"startedAt": now, "completedAt": now},
        "auditReferences": ["durable://task-record"],
    }


def recover(arguments) -> int:
    task, _, _ = load_task(arguments)
    coordinator = _production_coordinator(arguments.config, arguments.managed_identity_client_id)
    recovered = coordinator.recover(task["taskId"], task["taskVersion"])
    if recovered.status != TaskStatus.REWORK_REQUIRED:
        print(json.dumps({"status": recovered.status.value, "error": "expired VERIFYING attempt was not reconciled"}, sort_keys=True))
        return 2
    checkpoints = [entry for entry in recovered.audit if entry.get("event") == "QUALIFICATION_CHECKPOINT"]
    if not checkpoints:
        print(json.dumps({"status": recovered.status.value, "error": "durable preparation evidence is missing"}, sort_keys=True))
        return 2
    checkpoint = checkpoints[-1]
    checkpoint_details = checkpoint.get("details", {})
    prepared_checks = checkpoint_details.get("checks", {})
    if set(prepared_checks) != {"VMQ-RUNAWAY-TERMINATION", "VMQ-CONTAINER-CLEANUP"} or not all(prepared_checks.values()):
        print(json.dumps({"status": recovered.status.value, "error": "preparation checks did not pass"}, sort_keys=True))
        return 2
    previous_fencing_token = checkpoint_details.get("fencingToken")
    lease = coordinator.claim(task["taskId"], task["taskVersion"], coordinator.config.worker_identity, 30)
    if not isinstance(previous_fencing_token, int) or lease.fencing_token <= previous_fencing_token:
        print(json.dumps({"error": "takeover did not issue a newer fencing token"}, sort_keys=True))
        return 2
    coordinator.begin_verification(task["taskId"], task["taskVersion"], lease.lease_id, lease.fencing_token)
    probe = """
import json, os, urllib.request
secret = os.environ.get('COORDINATOR_SECRET_SENTINEL')
host_exposed = os.path.exists('/host-secret-sentinel') or os.path.exists('/etc/sandiva-hermes/runtime.json')
try:
    urllib.request.urlopen('https://example.com', timeout=2)
    network_denied = False
except Exception:
    network_denied = True
print(json.dumps({'secretIsolation': secret is None, 'filesystemIsolation': not host_exposed, 'networkDenied': network_denied, 'normalVerification': True}))
""".strip()
    os.environ["COORDINATOR_SECRET_SENTINEL"] = "HOST-ONLY-SENTINEL"
    with tempfile.TemporaryDirectory(prefix="hermes-synthetic-input-") as workspace:
        Path(workspace, "probe.py").write_text(probe + "\n", encoding="utf-8")
        job = BoundedProcessRunner(policy(arguments.image, 20)).run_verification(
            task, workspace, ["python", "probe.py"],
            approved_job_environment={"HERMES_TASK_ID": task["taskId"]},
        )
    if job.terminated or job.return_code != 0:
        print(json.dumps({"error": "normal isolated job failed", "terminationReason": job.termination_reason}, sort_keys=True))
        return 3
    probe_evidence = json.loads(job.stdout)
    expected_probe = {"secretIsolation", "filesystemIsolation", "networkDenied", "normalVerification"}
    if set(probe_evidence) != expected_probe or any(value is not True for value in probe_evidence.values()):
        print(json.dumps({"error": "isolation probe failed", "evidence": probe_evidence}, sort_keys=True))
        return 4
    record_key = recovered.key
    trusted_evidence = [
        coordinator_observation_evidence(
            evidence_ref=f"audit://{record_key}/qualification/runaway-termination",
            kind="coordinator-observation",
            source=f"audit://{record_key}/qualification-checkpoint",
            result="PASS",
            criteria=["VMQ-RUNAWAY-TERMINATION"],
            details={"terminated": True, "preparationAttemptId": checkpoint_details.get("attemptId")},
        ),
        coordinator_observation_evidence(
            evidence_ref=f"audit://{record_key}/qualification/container-cleanup",
            kind="coordinator-observation",
            source=f"audit://{record_key}/qualification-checkpoint",
            result="PASS",
            criteria=["VMQ-CONTAINER-CLEANUP"],
            details={"containerCleanup": True, "preparationAttemptId": checkpoint_details.get("attemptId")},
        ),
        coordinator_observation_evidence(
            evidence_ref=f"audit://{record_key}/qualification/restart-recovery",
            kind="runtime-state",
            source=f"audit://{record_key}/recovery",
            result="PASS",
            criteria=["VMQ-RESTART-RECOVERY"],
            details={"recoveredStatus": recovered.status.value, "attemptCount": recovered.attempt_count},
        ),
        coordinator_observation_evidence(
            evidence_ref=f"audit://{record_key}/qualification/lease-fencing/{lease.fencing_token}",
            kind="lease-fencing",
            source=f"audit://{record_key}/lease-history",
            result="PASS",
            criteria=["VMQ-LEASE-FENCING"],
            details={"previousFencingToken": previous_fencing_token, "newFencingToken": lease.fencing_token},
        ),
        coordinator_observation_evidence(
            evidence_ref=f"audit://{record_key}/qualification/durable-state-recovery",
            kind="coordinator-audit",
            source=f"audit://{record_key}",
            result="PASS",
            criteria=["VMQ-DURABLE-STATE-RECOVERY"],
            details={"checkpointRecovered": True, "attemptCount": recovered.attempt_count},
        ),
    ]
    job_evidence = []
    probe_mapping = {
        "VMQ-SECRET-ISOLATION": "secretIsolation",
        "VMQ-FILESYSTEM-ISOLATION": "filesystemIsolation",
        "VMQ-NETWORK-ISOLATION": "networkDenied",
        "VMQ-NORMAL-VERIFICATION": "normalVerification",
    }
    for criterion, observation in probe_mapping.items():
        job_evidence.append(
            {
                "evidenceRef": f"isolated-job://{lease.attempt_id}/{observation}",
                "kind": "isolated-job-observation",
                "source": f"isolated-job://{lease.attempt_id}/stdout",
                "result": "PASS" if probe_evidence[observation] else "FAIL",
                "criteria": [criterion],
                "details": {"observation": observation, "value": probe_evidence[observation], "returnCode": job.return_code},
            }
        )
    criterion_evidence = {
        item.criteria[0]: [item.evidence_ref] for item in trusted_evidence
    }
    criterion_evidence.update({item["criteria"][0]: [item["evidenceRef"]] for item in job_evidence})
    candidate = result_candidate(task, lease, job_evidence, criterion_evidence, trusted_evidence)
    final = coordinator.complete_attempt(
        task["taskId"], task["taskVersion"], candidate, lease.lease_id, lease.fencing_token,
        trusted_evidence=trusted_evidence,
    )
    print(json.dumps({"taskId": task["taskId"], "status": final.status.value, "attemptCount": final.attempt_count, "fencingToken": lease.fencing_token, "probe": probe_evidence}, sort_keys=True))
    return 0 if final.status == TaskStatus.READY_FOR_PM_ACCEPTANCE and final.attempt_count == 2 else 5


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("prepare", "recover"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--specification", required=True)
    parser.add_argument("--acceptance-contract", required=True)
    parser.add_argument("--image", required=True, help="approved preloaded verification image pinned with @sha256")
    parser.add_argument("--managed-identity-client-id")
    arguments = parser.parse_args()
    return prepare(arguments) if arguments.phase == "prepare" else recover(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
