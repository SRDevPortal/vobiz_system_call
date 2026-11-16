"""Repair missing Complete Call fields and indexes on existing sites."""
from vobiz_system_call.install import ensure_completion_fields, ensure_indexes


def execute():
    ensure_completion_fields()
    ensure_indexes()
