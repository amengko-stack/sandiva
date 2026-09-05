from __future__ import annotations

import argparse
import json
from pathlib import Path

from .config import RuntimeConfig
from .contracts import validate_build_task, validate_reference_hashes
from .coordinator import Coordinator
from .health_server import create_health_server
from .identity import ManagedIdentityTokenProvider
from .sharepoint_store import SharePointListStateStore


def _read_json(path: str) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one JSON object")
    return value


def _production_coordinator(config_path: str, managed_identity_client_id: str | None) -> Coordinator:
    config = RuntimeConfig.from_mapping(_read_json(config_path))
    if config.environment_kind != "production":
        raise ValueError("runtime commands require an authoritative production VM configuration")
    token_provider = ManagedIdentityTokenProvider(client_id=managed_identity_client_id)
    store = SharePointListStateStore(
        config.state_endpoint, config.task_namespace, config.environment_id, token_provider,
    )
    return Coordinator(store, config)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hermes-build-steward")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate-task", help="validate a Build Task and canonical artifact hashes without changing state")
    validate.add_argument("--task", required=True)
    validate.add_argument("--specification", required=True)
    validate.add_argument("--acceptance-contract", required=True)

    for name in ("recover", "health", "serve-health"):
        command = subparsers.add_parser(name)
        command.add_argument("--config", required=True)
        command.add_argument("--managed-identity-client-id")
        if name == "recover":
            command.add_argument("--task-id", required=True)
            command.add_argument("--task-version", required=True, type=int)
        elif name == "serve-health":
            command.add_argument("--bind", default="127.0.0.1")
            command.add_argument("--port", default=8787, type=int)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "validate-task":
        task = validate_build_task(_read_json(arguments.task))
        validate_reference_hashes(
            task, Path(arguments.specification).read_bytes(), Path(arguments.acceptance_contract).read_bytes(),
        )
        print(json.dumps({"taskId": task["taskId"], "taskVersion": task["taskVersion"], "valid": True}, sort_keys=True))
        return 0

    coordinator = _production_coordinator(arguments.config, arguments.managed_identity_client_id)
    if arguments.command == "recover":
        record = coordinator.recover(arguments.task_id, arguments.task_version)
        print(json.dumps({"taskId": arguments.task_id, "taskVersion": arguments.task_version, "status": record.status.value}, sort_keys=True))
    elif arguments.command == "health":
        print(json.dumps(coordinator.health(), sort_keys=True))
    elif arguments.command == "serve-health":
        server = create_health_server(coordinator, arguments.bind, arguments.port)
        try:
            server.serve_forever()
        finally:
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
