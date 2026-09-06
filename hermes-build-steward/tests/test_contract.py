from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from helpers import AC_BYTES, SPEC_BYTES, build_task
from hermes_steward.contracts import (
    ContractValidationError,
    REQUIRED_TASK_FIELDS,
    validate_build_task,
    validate_reference_hashes,
    validate_repository_paths,
    validate_verification_command,
)


class CanonicalBuildTaskTests(unittest.TestCase):
    def test_complete_task_is_accepted_and_normalized(self):
        task = validate_build_task(build_task())
        self.assertEqual(task["taskId"], "HERMES-01-SYNTHETIC-001")
        self.assertEqual(task["executionStatus"], "CREATED")

    def test_every_required_field_is_enforced(self):
        baseline = build_task()
        for field in tuple(baseline):
            with self.subTest(field=field):
                candidate = copy.deepcopy(baseline)
                del candidate[field]
                with self.assertRaises(ContractValidationError):
                    validate_build_task(candidate)

    def test_unknown_fields_fail_closed_including_secret_payloads(self):
        with self.assertRaisesRegex(ContractValidationError, "unknown"):
            validate_build_task(build_task(AZURE_CLIENT_SECRET="sentinel"))
        nested = build_task()
        nested["executorPolicy"]["accessToken"] = "sentinel"
        with self.assertRaisesRegex(ContractValidationError, "secret"):
            validate_build_task(nested)

    def test_task_size_and_retry_count_are_bounded_for_the_durable_record(self):
        with self.assertRaisesRegex(ContractValidationError, "size"):
            validate_build_task(build_task(scope=["x" * 9000]))
        with self.assertRaisesRegex(ContractValidationError, "at most 3"):
            validate_build_task(build_task(retryPolicy={"maxAttempts": 4, "backoffSeconds": 30}))

    def test_malformed_task_fails_closed(self):
        with self.assertRaises(ContractValidationError):
            validate_build_task(build_task(taskVersion=0, repository="not-a-url"))

    def test_repository_is_exact_canonical_github_owner_and_repository(self):
        for repository in (
            "https://github.com/amengko-stack/sandiva/extra",
            "https://github.com/amengko-stack/sandiva?token=secret",
            "https://github.com/amengko-stack/sandiva#fragment",
            "https://user@github.com/amengko-stack/sandiva",
        ):
            with self.subTest(repository=repository):
                with self.assertRaises(ContractValidationError):
                    validate_build_task(build_task(repository=repository))

    def test_specification_and_acceptance_hashes_are_verified(self):
        task = validate_build_task(build_task())
        validate_reference_hashes(task, SPEC_BYTES, AC_BYTES)
        with self.assertRaisesRegex(ContractValidationError, "specificationHash"):
            validate_reference_hashes(task, b"changed", AC_BYTES)
        with self.assertRaisesRegex(ContractValidationError, "acceptanceContractHash"):
            validate_reference_hashes(task, SPEC_BYTES, b"changed")

    def test_permitted_and_prohibited_paths_fail_closed(self):
        task = validate_build_task(build_task())
        validate_repository_paths(task, ["hermes-build-steward/src/hermes_steward/contracts.py"])
        for path in ("sln-litigation-drafter/app/page.tsx", "../outside", "client/src/app.tsx"):
            with self.subTest(path=path):
                with self.assertRaises(ContractValidationError):
                    validate_repository_paths(task, [path])

    def test_published_json_schema_matches_runtime_required_fields(self):
        schema = json.loads((Path(__file__).parents[1] / "schemas" / "canonical-build-task-v1.schema.json").read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), REQUIRED_TASK_FIELDS)

    def test_only_task_approved_verification_commands_can_run(self):
        task = validate_build_task(build_task())
        validate_verification_command(task, ["python", "-m", "unittest"])
        with self.assertRaises(ContractValidationError):
            validate_verification_command(task, ["sh", "-c", "curl https://evil.example"])


if __name__ == "__main__":
    unittest.main()
