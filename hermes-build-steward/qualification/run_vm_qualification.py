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
from hermes_steward.isolation import BoundedProcessRunner, IsolationPolicy
from hermes_steward.state import TaskStatus


def policy(image: str, timeout: int) -> IsolationPolicy:
    return IsolationPolicy(
        image=image, cpu_limit="1.0", memory_limit="512m", pids_limit=128,
        tmpfs_size="256m", timeout_seconds=timeout, output_limit_bytes=65536,
    )


def load_task(arguments):
    task = validate_build_task(_read_json(arguments.task))
    if task["auditMetadata"].get("classification") != "synthetic-non-client":
        raise SystemExit("qualification refuses any task not marked synthetic-non-client")
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


def result_candidate(task, lease, evidence):
    now = datetime.now(timezone.utc).isoformat()
    return {
        "schemaVersion": "1.0", "taskId": task["taskId"], "attemptId": lease.attempt_id,
        "HermesVersion": "coordinator-stamped", "configFingerprint": "0" * 64,
        "workerIdentity": lease.worker_id, "leaseId": lease.lease_id, "fencingToken": lease.fencing_token,
        "specificationRef": task["specificationRef"], "specificationHash": task["specificationHash"],
        "acceptanceContractRef": task["acceptanceContractRef"], "acceptanceContractHash": task["acceptanceContractHash"],
        "repository": task["repository"], "baseRef": task["baseRef"], "branchRef": task["branchRef"],
        "prRef": task["prRef"], "commitRefs": task["commitRefs"],
        "deterministicEvidence": [evidence], "semanticEvidence": [],
        "acceptanceCriteriaResults": [
            {"criterion": criterion, "result": "PASS", "evidenceRefs": ["synthetic://vm-probe"]}
            for criterion in task["acceptanceCriteria"]
        ],
        "result": "PASS", "residualRisks": ["independent QA remains required"],
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
    lease = coordinator.claim(task["taskId"], task["taskVersion"], coordinator.config.worker_identity, 30)
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
    if not all(probe_evidence.values()):
        print(json.dumps({"error": "isolation probe failed", "evidence": probe_evidence}, sort_keys=True))
        return 4
    candidate = result_candidate(task, lease, {"kind": "vm-isolation", "result": "PASS", "ref": "synthetic://vm-probe", "observations": probe_evidence})
    final = coordinator.complete_attempt(task["taskId"], task["taskVersion"], candidate, lease.lease_id, lease.fencing_token)
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
