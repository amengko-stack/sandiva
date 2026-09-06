from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from helpers import build_task
from hermes_steward.state import TaskStatus


def qualification_module():
    script_path = Path(__file__).parents[1] / "qualification" / "run_vm_qualification.py"
    spec = importlib.util.spec_from_file_location("workspace_vm_qualification", script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def qualification_task(module):
    task = build_task(
        acceptanceCriteria=list(module.QUALIFICATION_CRITERIA),
        criterionEvidencePolicy=copy.deepcopy(module.QUALIFICATION_EVIDENCE_POLICY),
        executorPolicy={
            "automaticDispatch": False,
            "approvedCommands": ["python runaway.py", "python probe.py"],
        },
    )
    task["auditMetadata"]["classification"] = "synthetic-non-client"
    return task


def arguments():
    return SimpleNamespace(
        config="runtime.json",
        image="python@sha256:" + "a" * 64,
    )


class QualificationWorkspaceTests(unittest.TestCase):
    def test_both_phases_make_synthetic_inputs_readable_by_the_nonroot_container(self):
        module = qualification_module()
        task = qualification_task(module)
        chmod_modes = []

        def record_chmod(_path, mode):
            chmod_modes.append(mode)

        prepare_coordinator = MagicMock()
        prepare_coordinator.config.worker_identity = "worker-1"
        prepare_coordinator.claim.return_value = SimpleNamespace(
            attempt_id="attempt-1", lease_id="lease-1", fencing_token=1,
        )
        prepare_job = SimpleNamespace(
            terminated=True,
            termination_reason="TIME_LIMIT",
            container_cleanup="REMOVED",
        )

        with (
            patch.object(module, "load_task", return_value=(task, b"spec", b"acceptance")),
            patch.object(module, "_production_coordinator", return_value=prepare_coordinator),
            patch.object(module.BoundedProcessRunner, "run_verification", return_value=prepare_job),
            patch.object(module.os, "_exit"),
            patch.object(Path, "chmod", autospec=True, side_effect=record_chmod),
        ):
            module.prepare(arguments())

        self.assertIn(0o755, chmod_modes)
        self.assertIn(0o644, chmod_modes)
        self.assertIn(0o700, chmod_modes)
        self.assertIn(0o600, chmod_modes)

        chmod_modes.clear()
        recovered = SimpleNamespace(
            status=TaskStatus.REWORK_REQUIRED,
            attempt_count=1,
            key="prod.tasks:HERMES-01:1",
            audit=[
                {
                    "event": "QUALIFICATION_CHECKPOINT",
                    "details": {
                        "attemptId": "attempt-1",
                        "fencingToken": 1,
                        "checks": {
                            "VMQ-RUNAWAY-TERMINATION": True,
                            "VMQ-CONTAINER-CLEANUP": True,
                        },
                    },
                }
            ],
        )
        recover_coordinator = MagicMock()
        recover_coordinator.config.worker_identity = "worker-1"
        recover_coordinator.recover.return_value = recovered
        recover_coordinator.claim.return_value = SimpleNamespace(
            attempt_id="attempt-2",
            worker_id="worker-1",
            lease_id="lease-2",
            fencing_token=2,
        )
        recover_coordinator.complete_attempt.return_value = SimpleNamespace(
            status=TaskStatus.READY_FOR_PM_ACCEPTANCE,
            attempt_count=2,
        )
        probe = {
            "secretIsolation": True,
            "certificateIsolation": True,
            "filesystemIsolation": True,
            "networkDenied": True,
            "normalVerification": True,
        }
        recover_job = SimpleNamespace(
            terminated=False,
            return_code=0,
            stdout=json.dumps(probe),
        )

        with (
            patch.object(module, "load_task", return_value=(task, b"spec", b"acceptance")),
            patch.object(module, "_production_coordinator", return_value=recover_coordinator),
            patch.object(module.BoundedProcessRunner, "run_verification", return_value=recover_job),
            patch.object(module, "result_candidate", return_value={"result": "PASS"}),
            patch.object(Path, "chmod", autospec=True, side_effect=record_chmod),
        ):
            self.assertEqual(module.recover(arguments()), 0)

        self.assertIn(0o755, chmod_modes)
        self.assertIn(0o644, chmod_modes)
        self.assertIn(0o700, chmod_modes)
        self.assertIn(0o600, chmod_modes)


if __name__ == "__main__":
    unittest.main()
