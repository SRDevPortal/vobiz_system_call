"""Capture authenticated Dial evidence; REST reconciliation supplies final billing."""
import re

import frappe
from vobiz_click_to_call.services.customer_reporting import direct_customer_call


def capture(row, payload, state):
    """Called under the call lock, only after verifying the per-call Dial token.

    Return False for a conflicting customer identity so that a delayed/wrong
    Dial event cannot change this call's outcome either.
    """
    if not direct_customer_call(row):
        return True
    uuid = str(payload.get("DialBLegUUID") or "").strip()
    if not uuid:
        return True
    if (not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", uuid)
            or uuid == row.get("call_uuid")
            or (row.get("b_leg_uuid") and row.b_leg_uuid != uuid)):
        return False
    values = {}
    if not row.get("b_leg_uuid"):
        values.update(b_leg_uuid=uuid, cdr_sync_status="Not Synced")
    if (state in ("answer", "answered", "connected", "in-progress", "in progress")
            and not row.get("answer_time") and row.get("cdr_sync_status") != "Synced"):
        values["answer_time"] = frappe.utils.now_datetime()
    # DialBLegBillDuration is a rounded billing unit (e.g. 60 for 5 seconds),
    # not the CDR billsec. Do not copy it into customer talk time.
    if values:
        frappe.db.set_value("Vobiz Call Log", row.name, values)
        row.update(values)
    return True


def reconcile_ended(row):
    """Called by the existing background worker, after committing call locks."""
    from vobiz_click_to_call.services.cdr import process_cdr_batch
    from vobiz_click_to_call.services.settings import get_settings
    if direct_customer_call(row) and row.get("b_leg_uuid") and row.get("cdr_sync_status") != "Synced":
        settings = get_settings()
        if not settings.enabled or not settings.enable_cdr_sync:
            return
        # Reuse the CDR cooldown and scheduled retry path; no REST in webhooks.
        return process_cdr_batch([row.name])
