from __future__ import annotations

from enum import Enum


class TaskStatus(str, Enum):
    CREATED = "CREATED"
    READY = "READY"
    LEASED = "LEASED"
    VERIFYING = "VERIFYING"
    READY_FOR_PM_ACCEPTANCE = "READY_FOR_PM_ACCEPTANCE"
    REWORK_REQUIRED = "REWORK_REQUIRED"
    PARTNER_DECISION_REQUIRED = "PARTNER_DECISION_REQUIRED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    COMPLETE = "COMPLETE"


class InvalidTransition(ValueError):
    pass


ALLOWED_TRANSITIONS = {
    TaskStatus.CREATED: {TaskStatus.READY, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.READY: {TaskStatus.LEASED, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.LEASED: {TaskStatus.VERIFYING, TaskStatus.READY, TaskStatus.REWORK_REQUIRED, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.VERIFYING: {
        TaskStatus.READY_FOR_PM_ACCEPTANCE, TaskStatus.REWORK_REQUIRED,
        TaskStatus.PARTNER_DECISION_REQUIRED, TaskStatus.FAILED, TaskStatus.CANCELLED,
    },
    TaskStatus.READY_FOR_PM_ACCEPTANCE: {TaskStatus.REWORK_REQUIRED, TaskStatus.CANCELLED},
    TaskStatus.REWORK_REQUIRED: {TaskStatus.READY, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.PARTNER_DECISION_REQUIRED: {TaskStatus.READY, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.FAILED: set(),
    TaskStatus.CANCELLED: set(),
    TaskStatus.COMPLETE: set(),
}


def validate_transition(current: TaskStatus, target: TaskStatus) -> None:
    if current == target:
        return
    if target not in ALLOWED_TRANSITIONS[current]:
        raise InvalidTransition(f"invalid task transition: {current.value} -> {target.value}")
