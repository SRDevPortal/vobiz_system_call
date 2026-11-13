"""Real Frappe call documents with isolated metadata and no database access."""
from types import SimpleNamespace
from unittest.mock import patch

import frappe
from vobiz_ai.vobiz_ai.doctype.vobiz_call_log.vobiz_call_log import VobizCallLog
from vobiz_system_call.api.lifecycle import CALL_FIELDS


def call_log_document(**values):
    fields = sorted(set(CALL_FIELDS) | set(values) | {
        "completion_provider_status", "completion_provider_due", "docstatus", "idx",
    })
    meta = SimpleNamespace(
        get_valid_columns=lambda: fields,
        get_table_fields=lambda: [],
        get_field=lambda name: None,
    )
    with patch.object(frappe, "get_meta", return_value=meta), patch.object(
        VobizCallLog, "get_valid_columns", return_value=fields
    ):
        return VobizCallLog(dict(doctype="Vobiz Call Log", **values))
