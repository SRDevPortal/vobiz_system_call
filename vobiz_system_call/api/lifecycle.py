"""Serialized browser call state. Network requests run only after releasing DB locks."""
from __future__ import annotations

import json
import re
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

import frappe
from frappe import _
from vobiz_click_to_call.api import call as core_call
from vobiz_click_to_call.services.safety import get_working_hours_block_reason

ACTIVE = ("Initiated", "Queued", "Agent Ringing", "Agent Answered", "Ringing", "Customer Answered", "Connected", "In Progress")
TERMINAL = frozenset(("Completed", "Failed", "Busy", "No Answer", "Cancelled", "Canceled"))
STARTUP_SECONDS = 45
PROVIDER_PENDING_SECONDS = 120
PRESENCE_SECONDS = 65
CALL_FIELDS = [
    "name", "user", "status", "call_status", "call_uuid", "recording_call_uuid", "answer_time", "end_time",
    "start_time", "creation", "reference_doctype", "reference_name", "request_json",
    "callback_token", "caller_id", "did_number", "customer_number", "direction",
    "agent_number", "normalized_customer_number", "from_number", "to_number", "modified",
]
PROVIDER_PENDING_STATUSES = frozenset(("browser-ended-pending-provider", "cancellation-requested"))
LOCAL_BROWSER_ACTIVE_STATUSES = frozenset((
    "browserCallStarted",
    "onCallRemoteRinging",
    "onCallAnswered",
    "browser-audio-connected",
))


def context(row):
    try:
        value = json.loads(row.get("request_json") or "{}")
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def is_browser_call(row):
    data = context(row)
    return data.get("source") == "vobiz_system_call" and data.get("call_device") == "Browser Softphone"


def is_managed_call(row):
    data = context(row)
    return is_browser_call(row) or (data.get("source") == "vobiz_system_call"
        and data.get("call_device") == "Mobile Bridge" and data.get("incoming_mobile_bridge") is True)


def lock_mapping(user):
    mapping = core_call.get_user_mapping(user)
    if not mapping:
        frappe.throw(_("No active Vobiz user mapping found."))
    core_call._lock_user_mapping(mapping["name"])
    # A locking read sees the latest committed state, including competing starts.
    return frappe.get_doc("Vobiz User Mapping", mapping["name"], for_update=True)


def assert_available(mapping):
    # Do not use the core helper: its stale-call path commits and drops the lock.
    if mapping.get("current_call_log"):
        frappe.throw(_("Your previous call is still being reconciled."))
    if not mapping.get("enabled") or mapping.get("availability_status") != "Available":
        frappe.throw(_("Your Vobiz availability must be Available."))
    if not frappe.utils.cint(mapping.get("accept_calls")):
        frappe.throw(_("You are not accepting Vobiz calls."))
    reason = get_working_hours_block_reason(mapping.as_dict())
    if reason:
        frappe.throw(reason)


def lock_call(name):
    user = frappe.db.get_value("Vobiz Call Log", name, "user")
    if not user:
        frappe.throw(_("Call log not found."))
    mapping = lock_mapping(user)
    columns = ", ".join("`" + f + "`" for f in CALL_FIELDS)
    rows = frappe.db.sql(
        f"SELECT {columns} FROM `tabVobiz Call Log` WHERE name = %s FOR UPDATE",
        (name,), as_dict=True,
    )
    if not rows or not is_managed_call(rows[0]):
        frappe.throw(_("This is not a managed Vobiz call."))
    return mapping, rows[0]


def terminal_status(previous, event, reason="", answered=False):
    if previous in TERMINAL:
        return previous
    if answered or previous in ("Connected", "In Progress"):
        return "Completed"
    if event in ("onCallFailed", "failed"):
        reason = (reason or "").lower()
        if "busy" in reason:
            return "Busy"
        if "no answer" in reason or "timeout" in reason:
            return "No Answer"
        return "Failed"
    return "Cancelled"


def finish_locked(mapping, row, event, reason="", status=None):
    """Caller holds mapping then call row locks. Preserve a final result."""
    if row.status in TERMINAL:
        release_locked(mapping, row)
        return row.status
    result = status or terminal_status(row.status, event, reason, bool(row.answer_time))
    if result not in TERMINAL:
        raise ValueError("Expected a terminal status")
    now = frappe.utils.now_datetime()
    values = {
        "status": result, "end_time": row.end_time or now,
        "call_status": event, "hangup_cause": (reason or "")[:140],
    }
    if row.answer_time:
        # Local elapsed audio time; provider billsec remains authoritative.
        values["duration"] = max(0, (now - frappe.utils.get_datetime(row.answer_time)).total_seconds())
    frappe.db.set_value("Vobiz Call Log", row.name, values)
    release_locked(mapping, row)
    if row.reference_doctype and row.reference_name:
        from vobiz_click_to_call.services.disposition import update_reference_call_metrics
        update_reference_call_metrics(row.reference_doctype, row.reference_name)
    from vobiz_ai.api.call_log import sync_linked_summaries
    completed = frappe.get_doc("Vobiz Call Log", row.name)
    sync_linked_summaries(completed)
    if is_browser_call(row) or context(row).get("incoming_mobile_bridge"):
        from vobiz_click_to_call.services.realtime import publish_call_disconnected
        publish_call_disconnected(completed)
    return result



def release_locked(mapping, row):
    now = frappe.utils.now_datetime()
    if mapping.current_call_log == row.name:
        available = (mapping.availability_status == "Busy" and bool(mapping.auto_available_after_call)
                     and (not is_browser_call(row) or bool(presence(mapping.user))))
        next_status = mapping.availability_status if mapping.availability_status in ("Offline", "Away") else (
            "Available" if available else "Away"
        )
        frappe.db.set_value("Vobiz User Mapping", mapping.name, {
            "current_call_log": "", "accept_calls": int(available),
            "availability_status": next_status,
            "last_status_at": now,
        })

def presence(user):
    return frappe.cache().get_value("vsc:presence:" + user, expires=True)


def set_presence(user, tab_id):
    frappe.cache().set_value("vsc:presence:" + user, tab_id, expires_in_sec=PRESENCE_SECONDS)


def startup_expired(row):
    return frappe.utils.get_datetime(row.creation) + timedelta(seconds=STARTUP_SECONDS) < frappe.utils.now_datetime()


def has_browser_terminal_event(row):
    # Legacy "hangup" was also written by Cancel and is not termination evidence.
    return context(row).get("browser_terminal_event") in {
        "onCallTerminated", "onCallFailed", "terminated", "failed",
    }


def provider_pending_values(row, event, reason=""):
    data = context(row)
    if not has_browser_terminal_event(row):
        data.update({
            "browser_terminal_event": str(event or "")[:80],
            "browser_terminal_reason": str(reason or "")[:500],
            "browser_terminal_at": frappe.utils.now(),
        })
    return {
        "call_status": "browser-ended-pending-provider",
        "request_json": json.dumps(data),
    }


def provider_pending_expired(row):
    # Browser/SDK termination and elapsed time do not prove the customer leg ended.
    # Keep the reservation until a provider callback or an exact final CDR arrives.
    if is_browser_call(row):
        return False
    if row.status in TERMINAL or row.call_status not in PROVIDER_PENDING_STATUSES:
        return False
    data = context(row)
    # A cancellation request is not evidence that the voice connection ended.
    if not has_browser_terminal_event(row):
        return False
    activity = data.get("browser_terminal_at") or row.get("modified") or row.get("creation")
    return frappe.utils.get_datetime(activity) + timedelta(seconds=PROVIDER_PENDING_SECONDS) < frappe.utils.now_datetime()


def provider_pending_outcome(row):
    data = context(row)
    event = data.get("browser_terminal_event") or ("hangup" if row.call_status == "cancellation-requested" else "terminated")
    reason = data.get("browser_terminal_reason") or "Provider final callback timeout"
    if row.call_status == "cancellation-requested" and not has_browser_terminal_event(row):
        return "Cancelled", event, reason
    return terminal_status(row.status, event, reason, bool(row.answer_time)), event, reason


def finish_provider_pending_if_expired(call_log, expected_uuid=None):
    mapping, row = lock_call(call_log)
    if expected_uuid and row.call_uuid != expected_uuid:
        frappe.db.rollback()
        return False
    if provider_pending_expired(row):
        status, event, reason = provider_pending_outcome(row)
        finish_locked(mapping, row, "provider-timeout", reason or event, status=status)
        frappe.db.commit()
        return True
    frappe.db.commit()
    return False


def enqueue_reconcile(name):
    try:
        frappe.enqueue(
            "vobiz_system_call.api.lifecycle.reconcile_call",
            call_log=name, queue="short", timeout=120, enqueue_after_commit=True,
            job_id="vsc-reconcile-" + name, deduplicate=True,
        )
    except Exception:
        # The mapping remains reserved; the bounded scheduler will retry later.
        frappe.log_error(title="Vobiz reconciliation queue unavailable", message=frappe.get_traceback())



def provider_outcome(cdr, answered=False):
    """Do not infer customer answer from billable browser/A-leg duration."""
    state = str(cdr.get("dial_status") or cdr.get("b_leg_status") or
                cdr.get("status") or cdr.get("call_status") or "").lower().replace("_", "-")
    reason = str(cdr.get("hangup_cause") or cdr.get("hangup_cause_name") or "").lower()
    signal = state + " " + reason
    if "busy" in signal:
        return "Busy"
    if any(value in signal for value in ("no-answer", "no answer", "timeout", "unanswered")):
        return "No Answer"
    if any(value in signal for value in ("cancel", "reject", "decline")):
        return "Cancelled"
    if any(value in signal for value in ("fail", "error")):
        return "Failed"
    if state in ("completed", "hangup", "ended") or cdr.get("end_time"):
        return "Completed" if answered else "No Answer"
    return None

def find_recovery_cdr(client, snapshot):
    """Bounded fallback when the provider ignores its call_uuid search filter."""
    from vobiz_click_to_call.services.cdr import extract_cdr_rows

    uuid = snapshot["call_uuid"]
    response = client.search_cdrs({"call_uuid": uuid})
    match = next((r for r in extract_cdr_rows(response)
                  if str(r.get("uuid") or r.get("call_uuid") or "") == uuid), None)
    if match:
        return match
    customer = str(snapshot.get("customer_number") or "").lstrip("+")
    if not customer:
        return None
    params = {"from_number" if snapshot.get("direction") == "Incoming" else "to_number": customer,
              "per_page": 50}
    if snapshot.get("direction") == "Outgoing":
        username = context(snapshot).get("endpoint_username")
        if username:
            params["from_number"] = username
    for page in (1, 2):
        response = client.search_cdrs(dict(params, page=page))
        match = next((r for r in extract_cdr_rows(response)
                      if str(r.get("uuid") or r.get("call_uuid") or "") == uuid), None)
        if match:
            return match
        if not (response.get("pagination") or {}).get("has_next"):
            break
    return None


def browser_recovery_uuid(row):
    """An SDK candidate is not an authenticated routing ID; never promote it blindly."""
    candidate = str(row.get("recording_call_uuid") or "")
    if (is_browser_call(row) and row.get("direction") == "Outgoing"
            and not row.get("call_uuid")
            and re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", candidate)):
        return candidate
    return None


def provider_datetime(value):
    """Provider REST times are UTC; Frappe stores datetimes in the site timezone."""
    if not value:
        return None
    try:
        dt = frappe.utils.get_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(ZoneInfo(frappe.utils.get_system_timezone())).replace(tzinfo=None)
    except (ValueError, TypeError, OverflowError):
        return None


def verified_browser_candidate(snapshot, evidence):
    """Match exact ID, browser endpoint, destination and start time before any action."""
    uuid = browser_recovery_uuid(snapshot)
    if not uuid or str(evidence.get("uuid") or evidence.get("call_uuid") or "") != uuid:
        return False
    endpoint = str(context(snapshot).get("endpoint_username") or "")
    source = str(evidence.get("caller_id_number") or evidence.get("from") or "")
    source = re.sub(r"^sips?:", "", source).split("@", 1)[0]
    target = re.sub(r"\D", "", str(evidence.get("destination_number") or evidence.get("to") or ""))
    customer = re.sub(r"\D", "", str(snapshot.get("customer_number") or ""))
    started = provider_datetime(evidence.get("start_time") or evidence.get("session_start"))
    if not endpoint or source != endpoint or not customer or target != customer or not started:
        return False
    created = frappe.utils.get_datetime(snapshot.get("creation"))
    return abs((started - created).total_seconds()) <= STARTUP_SECONDS


def final_provider_cdr(cdr):
    state = str(cdr.get("status") or cdr.get("call_status") or "").lower().replace("_", "-")
    if state in ("in-progress", "live", "ringing", "answered", "connected", "queued"):
        return False
    return bool(cdr.get("end_time")) or state in {
        "completed", "hangup", "ended", "failed", "busy", "no-answer", "cancelled", "canceled",
    }


def reconcile_missing_browser_id(snapshot, recovery_lookup=False):
    """Recover only a verified outbound browser leg, without changing routing identity."""
    uuid = browser_recovery_uuid(snapshot)
    if not uuid:
        return
    from vobiz_click_to_call.services.settings import get_settings
    from vobiz_click_to_call.services.client import VobizClient
    settings = get_settings()
    if not settings.enabled:
        return
    client = VobizClient(settings)
    client.timeout = 3
    # Check final evidence first: an already-ended call needs no further DELETE.
    try:
        cdr = find_recovery_cdr(client, dict(snapshot, call_uuid=uuid))
        if cdr and final_provider_cdr(cdr) and verified_browser_candidate(snapshot, cdr):
            finish_reconciled_call(snapshot, cdr, missing_id=True)
            return
    except Exception:
        pass  # A CDR outage must not disable the independent live hangup attempt.
    if recovery_lookup or not context(snapshot).get("agent_cancelled"):
        return
    try:
        live = client.retrieve_live_call(uuid)
        evidence = live.get("data") if isinstance(live.get("data"), dict) else live
        if not verified_browser_candidate(snapshot, evidence):
            return
        state = str(evidence.get("call_status") or evidence.get("status") or "").lower().replace("_", "-")
        if state not in ("in-progress", "live", "ringing", "answered", "connected"):
            return
        mapping, current = lock_call(snapshot["name"])
        unchanged = (browser_recovery_uuid(current) == uuid and current.status not in TERMINAL
                     and mapping.current_call_log == current.name and context(current).get("agent_cancelled"))
        frappe.db.commit()
        if unchanged:
            client.hangup_call(uuid, allow_missing=True)
        # DELETE success/404 is not terminal proof. The scheduler checks again.
    except Exception:
        frappe.db.rollback()
        frappe.log_error(title="Vobiz browser fallback retry pending", message=frappe.get_traceback())


def reconcile_call(call_log, recovery_lookup=False):
    """Expire unissued calls; release provider calls only after matching terminal CDR."""
    mapping, row = lock_call(call_log)
    if row.status in TERMINAL:
        release_locked(mapping, row)
        frappe.db.commit()
        return
    if not row.call_uuid:
        if browser_recovery_uuid(row):
            snapshot = dict(row)
            frappe.db.commit()
            return reconcile_missing_browser_id(snapshot, recovery_lookup=recovery_lookup)
        locally_started = (row.call_status in LOCAL_BROWSER_ACTIVE_STATUSES
                           or context(row).get("agent_cancelled") or has_browser_terminal_event(row)
                           or bool(row.get("recording_call_uuid")))
        if row.status not in TERMINAL and not locally_started and startup_expired(row):
            finish_locked(mapping, row, "onCallFailed", "Browser startup timeout")
        frappe.db.commit()
        return
    snapshot = dict(row)
    frappe.db.commit()  # Never hold mapping/log locks over provider requests.
    from vobiz_click_to_call.services.settings import get_settings
    from vobiz_click_to_call.services.client import VobizClient
    from vobiz_click_to_call.services.cdr import extract_cdr_rows
    settings = get_settings()
    if (not recovery_lookup and settings.enabled and context(snapshot).get("agent_cancelled")
            and snapshot["status"] not in TERMINAL):
        try:
            cancel_client = VobizClient(settings)
            if is_browser_call(snapshot):
                cancel_client.timeout = 3
            cancel_client.hangup_call(snapshot["call_uuid"], allow_missing=True)
        except Exception:
            # A failed DELETE must not prevent a terminal CDR from releasing the agent.
            frappe.log_error(title="Vobiz cancellation retry failed", message=frappe.get_traceback())
    if not settings.enabled or not settings.enable_cdr_sync:
        finish_provider_pending_if_expired(call_log, snapshot["call_uuid"])
        return  # Retain briefly unless a browser-ended provider wait has expired.
    # Query the exact provider UUID; do not constrain incoming calls with outgoing From/To.
    try:
        client = VobizClient(settings)
        if recovery_lookup or is_browser_call(snapshot):
            client.timeout = 3
            cdr = find_recovery_cdr(client, snapshot)
        else:
            response = client.search_cdrs({"call_uuid": snapshot["call_uuid"]})
            cdr = next((r for r in extract_cdr_rows(response)
                        if str(r.get("uuid") or r.get("call_uuid") or "") == snapshot["call_uuid"]), None)
    except Exception:
        if finish_provider_pending_if_expired(call_log, snapshot["call_uuid"]):
            return
        raise
    if not cdr:
        finish_provider_pending_if_expired(call_log, snapshot["call_uuid"])
        return
    if is_browser_call(snapshot) and not final_provider_cdr(cdr):
        return
    finish_reconciled_call(snapshot, cdr)


def finish_reconciled_call(snapshot, cdr, missing_id=False):
    status = provider_outcome(cdr, bool(snapshot.get("answer_time")))
    if status not in TERMINAL:
        # Explicit provider activity must override elapsed local timeout.
        return
    call_log = snapshot["name"]
    mapping, row = lock_call(call_log)
    if (row.call_uuid != snapshot["call_uuid"] or
            (missing_id and browser_recovery_uuid(row) != browser_recovery_uuid(snapshot))):
        frappe.db.rollback()
        return
    ended = provider_datetime(cdr.get("end_time"))
    if ended and row.status not in TERMINAL:
        row.end_time = ended
    finish_locked(mapping, row, "provider-cdr", str(cdr.get("hangup_cause") or ""), status=status)
    # CDR can enrich a final call without changing an already final outcome.
    values = {"cdr_sync_status": "Synced", "cdr_synced_at": frappe.utils.now(),
              "cdr_json": json.dumps({"matched_cdr": cdr}, default=str)}
    for target, keys in {
        "duration": ("duration", "call_duration"), "billsec": ("billsec", "bill_seconds"),
        "recording_url": ("recording_url", "record_url"),
    }.items():
        for key in keys:
            if cdr.get(key) is not None:
                values[target] = cdr[key]
                break
    frappe.db.set_value("Vobiz Call Log", call_log, values)
    frappe.db.commit()


def recover_calls():
    """Bounded keyset scan of mappings; no full call-log scan or synchronous network work."""
    cache = frappe.cache()
    cursor = cache.get_value("vsc:recovery-cursor") or ""
    rows = frappe.get_all(
        "Vobiz User Mapping", filters={"name": [">", cursor]}, fields=["name", "current_call_log"],
        order_by="name asc", limit_start=0, limit_page_length=100,
    )
    cache.set_value("vsc:recovery-cursor", rows[-1].name if len(rows) == 100 else "", expires_in_sec=3600)
    names = [r.current_call_log for r in rows if r.current_call_log]
    if not names:
        return
    calls = frappe.get_all(
        "Vobiz Call Log", filters={"name": ["in", names]},
        fields=["name", "request_json"], limit_start=0, limit_page_length=100,
    )
    for row in calls:
        if is_managed_call(row):
            enqueue_reconcile(row.name)
