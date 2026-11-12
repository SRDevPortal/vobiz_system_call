"""Provider cleanup explicitly requested by Complete Call, independent of availability.

SQL status/due fields survive queue or cache loss. Workers only update the old
call's audit state; they never reserve/release a mapping or publish disconnects.
"""
import json
import re
from datetime import timedelta

import frappe

from vobiz_system_call.api import lifecycle
from vobiz_click_to_call.services.client import VobizClient
from vobiz_click_to_call.services.settings import get_settings

KEY = "complete_provider"
MAX_ATTEMPTS = 8
BATCH_SIZE = 4
HTTP_TIMEOUT = 2
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


def state(row):
    value = lifecycle.context(row).get(KEY)
    return value if isinstance(value, dict) and value.get("version") == 1 else {}


def targets(row):
    # Only server-authenticated routing IDs; never blindly use an SDK UUID.
    ids = [row.get("call_uuid"), row.get("b_leg_uuid")]
    conference = lifecycle.context(row).get("conference_recovery") or {}
    if isinstance(conference, dict) and conference.get("version") == 1:
        ids += [leg.get("uuid") for leg in conference.get("legs", {}).values() if isinstance(leg, dict)]
    return list(dict.fromkeys(value for value in ids if isinstance(value, str) and UUID.fullmatch(value)))


def save(row, value, status="Pending", delay=60):
    data = lifecycle.context(row)
    data[KEY] = value
    values = {
        "request_json": json.dumps(data), "completion_provider_status": status,
        "completion_provider_due": frappe.utils.now_datetime() + timedelta(seconds=delay)
        if status == "Pending" else None,
    }
    frappe.db.set_value("Vobiz Call Log", row.name, values)
    row.update(values)


def prepare(row):
    """Persist explicit intent under the button's ownership locks before I/O."""
    if state(row):
        return False
    data = lifecycle.context(row)
    data["agent_cancelled"] = True
    data.setdefault("agent_cancel_requested_at", frappe.utils.now())
    row.request_json = json.dumps(data)
    save(row, {"version": 1, "requested_at": frappe.utils.now(),
               "requested_by": frappe.session.user, "attempts": 0,
               "confirmed_ids": [], "last_result": "not_attempted"})
    return True


def client():
    provider = VobizClient(get_settings())
    # One inline DELETE, with 2s connect and 2s read timeouts. No provider
    # polling or retry loop in the button request. DNS/platform delays can add time.
    provider.timeout = HTTP_TIMEOUT
    return provider


def request_hangup(provider, uuid):
    try:
        result = provider.hangup_call(uuid, allow_missing=True) or {}
        if result.get("request_deferred"):
            return "deferred"
        if result.get("call_missing"):
            return "not_found_unconfirmed"
        if result.get("status_code") in (200, 202, 204):
            return "requested"
        return "unconfirmed"
    except Exception:
        # Never persist credentials, URLs, provider payloads or exception text.
        return "request_failed"


def attempt_inline(row):
    ids = targets(row)
    if not ids:
        return "missing_verified_id"
    try:
        return request_hangup(client(), ids[0])
    except Exception:
        return "request_failed"


def record_inline(row, result):
    value = state(row)
    value["inline_result"] = result
    value["last_result"] = result
    value["inline_at"] = frappe.utils.now()
    save(row, value, row.get("completion_provider_status") or "Pending")


def enqueue(call_log):
    try:
        frappe.enqueue(
            "vobiz_system_call.api.complete_retry.verify_completion", call_log=call_log,
            queue="short", timeout=120, job_id="vsc-complete-" + call_log,
            deduplicate=True, enqueue_after_commit=False,
        )
    except Exception:
        # The SQL Pending/due record remains available to the minute scheduler.
        return False
    return True


def dispatch_due():
    rows = frappe.get_all(
        "Vobiz Call Log", filters={"completion_provider_status": "Pending",
                                  "completion_provider_due": ["<=", frappe.utils.now_datetime()]},
        fields=["name"], order_by="completion_provider_due asc", limit_page_length=100,
    )
    for row in rows:
        enqueue(row.name)
    return {"examined": len(rows)}


def exact_cdr(provider, uuid):
    from vobiz_click_to_call.services.cdr import extract_cdr_rows
    response = provider.retrieve_cdr(uuid)
    if not isinstance(response, dict):
        return None
    data = response.get("data")
    rows = [response] + ([data] if isinstance(data, dict) else []) + extract_cdr_rows(response)
    return next((cdr for cdr in rows if str(cdr.get("call_uuid") or cdr.get("uuid") or "") == uuid
                 and lifecycle.final_provider_cdr(cdr)), None)


def check_target(provider, snapshot, uuid, candidate=False):
    # Final exact-ID evidence, not DELETE success or HTTP 404, confirms termination.
    try:
        cdr = exact_cdr(provider, uuid)
        if cdr and (not candidate or lifecycle.verified_browser_candidate(snapshot, cdr)):
            return True, "confirmed"
    except Exception:
        pass  # CDR outage must not prevent the independently bounded hangup.
    if candidate:
        try:
            live = provider.retrieve_live_call(uuid)
            evidence = live.get("data") if isinstance(live.get("data"), dict) else live
            if not lifecycle.verified_browser_candidate(snapshot, evidence):
                return False, "unverified_id"
        except Exception:
            return False, "unverified_id"
    return False, request_hangup(provider, uuid)


def verify(call_log):
    row = frappe.get_doc("Vobiz Call Log", call_log, for_update=True)
    value = state(row)
    if not value or row.get("completion_provider_status") != "Pending":
        frappe.db.commit()
        return
    # A SQL lease prevents concurrent checks; a killed worker becomes due again.
    now = frappe.utils.now_datetime()
    if value.get("lease_until") and frappe.utils.get_datetime(value["lease_until"]) > now:
        frappe.db.commit()
        return
    attempt = int(value.get("attempts") or 0) + 1
    if attempt > MAX_ATTEMPTS:
        value["last_result"] = "review_required"
        save(row, value, "Needs Review")
        frappe.db.commit()
        return
    value.update(attempts=attempt, lease_until=str(now + timedelta(seconds=150)))
    save(row, value, delay=150)
    snapshot = dict(row)
    frappe.db.commit()  # No row/mapping lock across provider requests.
    ids = targets(snapshot)
    candidate = lifecycle.browser_recovery_uuid(snapshot) if not ids else None
    if candidate:
        ids = [candidate]
    confirmed = set(value.get("confirmed_ids") or [])
    unresolved = [uuid for uuid in ids if uuid not in confirmed]
    # Rotate a bounded batch so a failing leg cannot starve other conference legs.
    offset = int(value.get("cursor") or 0) % max(1, len(unresolved))
    batch = (unresolved[offset:] + unresolved[:offset])[:BATCH_SIZE]
    results = {}
    try:
        provider = client()
        for uuid in batch:
            ended, result = check_target(provider, snapshot, uuid, candidate=bool(candidate))
            results[uuid] = result
            if ended:
                confirmed.add(uuid)
    except Exception:
        results = {uuid: "request_failed" for uuid in batch}
    # Merge with the latest callback data. Do not touch availability or call outcomes.
    row = frappe.get_doc("Vobiz Call Log", call_log, for_update=True)
    current = state(row)
    if current.get("attempts") != attempt or current.get("requested_at") != value.get("requested_at"):
        frappe.db.commit()
        return
    current.update(confirmed_ids=sorted(confirmed), last_results=results, cursor=offset + len(batch),
                   checked_at=frappe.utils.now(), lease_until=None)
    latest = targets(row)
    if not latest and candidate and lifecycle.browser_recovery_uuid(row) == candidate:
        latest = [candidate]
    complete = bool(latest) and set(latest).issubset(confirmed)
    status = "Confirmed" if complete else "Needs Review" if attempt >= MAX_ATTEMPTS else "Pending"
    current["last_result"] = "confirmed" if complete else "provider_end_unconfirmed"
    save(row, current, status, delay=min(900, 60 * 2 ** min(attempt - 1, 4)))
    frappe.db.commit()
