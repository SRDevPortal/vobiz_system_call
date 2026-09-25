"""Authenticated outbound Dial evidence, separate from generic parent termination."""
import json

import frappe


def apply(mapping, row, payload, state):
    from vobiz_system_call.api import lifecycle
    from vobiz_click_to_call.services.reference_sync import request_reference_sync

    data = lifecycle.context(row)
    if row.get("direction") != "Outgoing" or data.get("conference_recovery"):
        return False
    # This function is called only AFTER the per-call provider token is verified.
    # Never classify an incoming Dial B-leg (the agent) as the customer.
    cause = str(payload.get("DialBLegHangupCause") or payload.get("DialHangupCause") or "")
    uuid = str(payload.get("DialBLegUUID") or "")
    previous = data.get("customer_outcome") or {}
    if not isinstance(previous, dict):
        previous = {}
    if previous.get("uuid") and uuid and previous["uuid"] != uuid:
        return False
    failure = {
        "USER_BUSY": "Busy", "NO_ANSWER": "No Answer", "NO_USER_RESPONSE": "No Answer",
        "CALL_REJECTED": "Cancelled", "UNALLOCATED_NUMBER": "Failed",
    }.get(cause.upper()) or {
        "busy": "Busy", "no-answer": "No Answer", "timeout": "No Answer",
        "failed": "Failed", "cancel": "Cancelled",
    }.get(state)
    if not failure or row.get("answer_time"):
        return False
    # Do not replace a known outcome, an answered call, or manual completion.
    # A correction only refines a provisional parent/browser cancellation.
    if previous.get("status"):
        return False
    if row.status in lifecycle.TERMINAL and (
        row.status not in ("Cancelled", "Canceled")
        or row.get("call_status") not in ("terminated", "provider-hangup")
    ):
        return False
    data["customer_outcome"] = {
        "status": failure, "uuid": uuid, "cause": cause[:140],
        "source": str(payload.get("DialBLegHangupSource") or "")[:80],
    }
    values = {
        "request_json": json.dumps(data), "dial_status": failure.lower().replace(" ", "-"),
        "hangup_cause": cause[:140] or state, "call_status": "customer-leg-ended",
    }
    was_terminal = row.status in lifecycle.TERMINAL
    if was_terminal:
        values["status"] = failure
    frappe.db.set_value("Vobiz Call Log", row.name, values)
    row.request_json = values["request_json"]
    if was_terminal:
        # This is a display update, never a second disconnected/disposition event.
        request_reference_sync(row.name)
        if row.get("user"):
            frappe.publish_realtime("vobiz_call_outcome_corrected", {
                "name": row.name, "status": failure, "call_status": "customer-leg-ended",
                "dial_status": values["dial_status"], "hangup_cause": values["hangup_cause"],
                "customer_leg_attempted": True,
            }, user=row.user, after_commit=True)
    else:
        lifecycle.finish_locked(mapping, row, "customer-leg-ended", cause or state, status=failure)
    return True
