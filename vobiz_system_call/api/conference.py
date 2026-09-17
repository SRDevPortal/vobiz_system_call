"""Opt-in outbound conference recovery. Customer and browser are independent calls.

The call log's provider UUID always identifies the CUSTOMER. Browser callbacks
only change conference membership, never the customer's terminal status.
State is persisted under the mapping/log locks used by the ordinary call flow.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from urllib.parse import urlencode
from xml.etree import ElementTree as ET

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit

from vobiz_system_call.api import lifecycle
from vobiz_system_call.api.settings import (
    get_settings, get_inbound_callback_token, get_webhook_base_url,
    get_profile_endpoint_uri,
)
from vobiz_click_to_call.services.client import VobizClient, extract_provider_id
from vobiz_click_to_call.services.numbers import provider_phone_number

KEY = "conference_recovery"
REGISTRY = "vsc:conference-watch"
HEARTBEAT = "vsc:conference-sweep-heartbeat"
WORKER_HEARTBEAT = "vsc:conference-worker-heartbeat"
QUEUE = "vobiz_conference"
GRACE_SECONDS = 120
MAX_AGENT_LEGS = 64


def enabled(user):
    # User Mapping is authoritative. Existing calls retain their stored mode
    # even if an administrator disables recovery for subsequent calls.
    if not user or not frappe.get_meta("Vobiz User Mapping").has_field("browser_call_recovery_enabled"):
        return False
    return bool(frappe.utils.cint(frappe.db.get_value(
        "Vobiz User Mapping", {"user": user, "enabled": 1, "browser_softphone_enabled": 1},
        "browser_call_recovery_enabled",
    )))


def state(row):
    value = lifecycle.context(row).get(KEY)
    return value if isinstance(value, dict) and value.get("version") == 1 else {}


def assert_ready():
    """Require the dedicated dispatcher and both queues, including queue latency."""
    from vobiz_system_call.api import conference_jobs
    if not conference_jobs.health()["ready"]:
        frappe.throw(_("Call recovery is unavailable or busy. Ask your administrator to check the conference dispatcher and both call workers."))


def prepare(row, settings):
    now = time.time()
    limit = max(60, min(14400, int(settings.get("max_call_duration") or 3600)))
    value = {"version": 1, "room": "vsc-" + secrets.token_hex(20),
             "generation": 1, "route": "vsc" + secrets.token_hex(24),
             "legs": {}, "customer_issue": "new", "customer_ended": False,
             "deadline": now + GRACE_SECONDS, "expires_at": now + limit,
             "time_limit": limit, "closed": False}
    save(row, value)
    watch(row.name)
    return {"conference_recovery": True, "recovery_seconds": GRACE_SECONDS,
            **browser_join(row, value)}


def browser_join(row, value):
    # Vobiz invokes the endpoint application for number destinations; arbitrary
    # SIP usernames are rejected before our answer URL. The signed application
    # callback plus this one-call route token select a conference, never Dial.
    return {"destination": row.customer_number, "conference_generation": value["generation"],
            "conference_headers": {"X-VH-VSC": value["route"]}}


def browser_route(payload):
    for key, value in payload.items():
        if str(key).lower().replace("-", "").replace("_", "") in ("xvhvsc", "sipheaderxvhvsc"):
            return str(value)
    return ""


def save(row, value, **fields):
    data = lifecycle.context(row)
    data[KEY] = value
    encoded = json.dumps(data, default=str)
    frappe.db.set_value("Vobiz Call Log", row.name, {"request_json": encoded, **fields})
    row.request_json = encoded
    for key, item in fields.items():
        row[key] = item
    from vobiz_system_call.api.conference_jobs import schedule_state
    schedule_state(row.name, value)


def stopped(row, value, now=None):
    now = time.time() if now is None else now
    return bool(value.get("closed") or value.get("customer_ended")
                or row.status in lifecycle.TERMINAL or lifecycle.context(row).get("agent_cancelled")
                or now >= value.get("expires_at", 0)
                or (value.get("deadline") and now >= value["deadline"]))


def token(row, role, generation=0):
    secret = get_inbound_callback_token()
    room = state(row).get("room")
    if not secret or not room:
        return ""
    message = f"conference:{row.name}:{room}:{role}:{int(generation)}"
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def url(row, method, role, generation=0):
    query = urlencode({"call_log": row.name, "role": role, "generation": generation,
                       "token": token(row, role, generation)})
    return f"{get_webhook_base_url()}/api/method/vobiz_system_call.api.conference.{method}?{query}"


def authorize(call_log, role, generation, received):
    if role not in ("agent", "customer"):
        return False
    row = frappe.db.get_value("Vobiz Call Log", call_log, ["name", "request_json"], as_dict=True)
    expected = token(row, role, generation) if row else ""
    return bool(expected and received and hmac.compare_digest(expected, str(received)))


def watch(name, delay=30):
    from vobiz_system_call.api import conference_jobs
    conference_jobs.watch(name, delay)


def enqueue(name, urgent=False):
    from vobiz_system_call.api import conference_jobs
    conference_jobs.enqueue(name, urgent=urgent)


def sweep():
    # Compatibility/backup only. This cannot fake dedicated-dispatcher health.
    from vobiz_system_call.api import conference_jobs
    conference_jobs.dispatch_due()


def worker_heartbeat():
    frappe.cache().set_value(WORKER_HEARTBEAT, time.time(), expires_in_sec=180)


def current_leg(value):
    return value.get("legs", {}).get(str(value.get("generation")), {})


def bind_agent(row, value, uuid):
    leg = current_leg(value)
    if leg.get("uuid") and leg["uuid"] != uuid:
        return False
    if leg.get("ended") or leg.get("exited"):
        return False
    leg.update(uuid=uuid)
    value["legs"][str(value["generation"])] = leg
    return True


def answer_agent(raw_from, raw_to, payload):
    """Called only after webrtc.answer authenticates the provider application."""
    from vobiz_system_call.api import webrtc
    profiles = frappe.get_all("Vobiz User Mapping", filters={
        "browser_softphone_username": webrtc._sip_username(raw_from), "enabled": 1,
    }, fields=["name", "user"], limit_page_length=2)
    if len(profiles) != 1:
        return webrtc._xml_response(webrtc._hangup_xml())
    mapping = lifecycle.lock_mapping(profiles[0].user)
    if not mapping.current_call_log or not mapping.browser_softphone_enabled:
        return webrtc._xml_response(webrtc._hangup_xml())
    mapping, row = lifecycle.lock_call(mapping.current_call_log)
    value = state(row)
    uuid = webrtc._provider_uuid(payload)
    if (not value or row.direction != "Outgoing" or not uuid or stopped(row, value)
            or get_profile_endpoint_uri(mapping.as_dict()) != raw_from
            or webrtc._number(raw_to) != webrtc._number(row.customer_number)
            or browser_route(payload) != value["route"]
            or not bind_agent(row, value, uuid)):
        frappe.db.commit()
        return webrtc._xml_response(webrtc._hangup_xml())
    save(row, value)
    watch(row.name)
    xml = room_xml(row, "agent", value["generation"])
    frappe.db.commit()
    return webrtc._xml_response(xml)


def room_xml(row, role, generation=0):
    value = state(row)
    root = ET.Element("Response")
    settings = get_settings()
    remaining = max(1, int(value["expires_at"] - time.time()))
    if role == "customer" and settings.get("enable_recording"):
        # Conference record=true is documented ineffective. Record the single
        # enduring customer session; recovery does not create another recording.
        from vobiz_click_to_call.services.settings import build_callback_url
        attrs = {"recordSession": "true", "redirect": "false", "playBeep": "false",
                 "fileFormat": settings.get("recording_format") or "mp3",
                 "maxLength": str(min(remaining, int(settings.get("recording_time_limit") or remaining))),
                 "callbackUrl": build_callback_url("vobiz_click_to_call.api.webhook.recording_callback",
                                                     row.name, row.callback_token, settings),
                 "callbackMethod": "POST"}
        if settings.get("enable_transcription"):
            attrs.update(transcriptionType=settings.get("transcription_type") or "auto",
                         transcriptionUrl=build_callback_url("vobiz_click_to_call.api.webhook.transcription_callback",
                                                              row.name, row.callback_token, settings),
                         transcriptionMethod="POST")
        ET.SubElement(root, "Record", attrs)
    ET.SubElement(root, "Conference", {
        "stayAlone": "true", "endConferenceOnExit": "false",
        "startConferenceOnEnter": "true", "beep": "false", "timeLimit": str(remaining),
        "callbackUrl": url(row, "member", role, generation), "callbackMethod": "POST",
    }).text = value["room"]
    # Leaving a room must not fall through into another dialing operation.
    ET.SubElement(root, "Hangup")
    return '<?xml version="1.0" encoding="UTF-8"?>' + ET.tostring(root, encoding="unicode")


def originate_customer(call_log):
    """One external POST at most, even after timeout or a duplicate enter event."""
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    leg = current_leg(value)
    if (not value or stopped(row, value) or mapping.current_call_log != row.name
            or value.get("customer_issue") != "new" or not leg.get("entered") or leg.get("exited")):
        frappe.db.commit()
        return
    value["customer_issue"] = "issuing"
    save(row, value, call_status="conference-customer-starting")
    watch(row.name)
    payload = {"from": provider_phone_number(row.caller_id), "to": provider_phone_number(row.customer_number),
               "answer_url": url(row, "customer_answer", "customer"), "answer_method": "POST",
               "ring_url": url(row, "customer_ring", "customer"), "ring_method": "POST",
               "hangup_url": url(row, "ended", "customer"), "hangup_method": "POST",
               "fallback_url": url(row, "reject", "customer"), "fallback_method": "POST",
               "ring_timeout": "30", "time_limit": str(value["time_limit"])}
    frappe.db.commit()  # Persist the one-shot intent BEFORE contacting Vobiz.
    try:
        client = VobizClient(get_settings())
        client.timeout = 8
        response = client.make_call(payload)
        uuid = extract_provider_id(response, "call_uuid", "CallUUID")
        request_uuid = extract_provider_id(response, "request_uuid")
        from vobiz_system_call.api.webrtc import _provider_uuid
        uuid = _provider_uuid({"CallUUID": uuid})
    except Exception:
        # Unknown outcome: callbacks may still arrive. Never redial on timeout.
        mapping, row = lifecycle.lock_call(call_log)
        value = state(row)
        if value.get("customer_issue") == "issuing":
            value["customer_issue"] = "uncertain"
            save(row, value)
        enqueue(call_log)
        frappe.db.commit()
        return
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    if request_uuid:
        value["customer_request_uuid"] = request_uuid
    if uuid and (not row.call_uuid or row.call_uuid == uuid):
        value["customer_issue"] = "issued"
        save(row, value, call_uuid=uuid, recording_call_uuid=uuid)
    else:
        if not row.call_uuid:
            value["customer_issue"] = "uncertain"
        save(row, value)
    enqueue(call_log)  # Also catches End Call racing the POST response.
    frappe.db.commit()


def bind_customer(row, value, uuid):
    if not uuid or value.get("customer_issue") not in ("issuing", "issued", "uncertain"):
        return False
    if row.call_uuid and row.call_uuid != uuid:
        return False
    value["customer_issue"] = "issued"
    row.call_uuid = uuid
    return True


def customer_callback(call_log, role, generation, received, action):
    from vobiz_system_call.api import webrtc
    if role != "customer" or int(generation) != 0 or not authorize(call_log, role, generation, received):
        return webrtc._plain_response("Not permitted.", 403)
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    payload = webrtc._request_params()
    uuid = webrtc._provider_uuid(payload)
    if not bind_customer(row, value, uuid):
        return webrtc._xml_response(webrtc._hangup_xml())
    save(row, value, call_uuid=uuid, recording_call_uuid=uuid)
    if stopped(row, value):
        enqueue(row.name, urgent=True)
        frappe.db.commit()
        return webrtc._xml_response(webrtc._hangup_xml())
    if action == "answer":
        save(row, value, answer_time=row.answer_time or frappe.utils.now(),
             status="Connected", call_status="conference-customer-answered")
        xml = room_xml(row, role)
    else:
        if not row.answer_time:
            save(row, value, status="Ringing", call_status="conference-customer-ringing")
        xml = webrtc._empty_xml()
    watch(row.name)
    frappe.db.commit()
    return webrtc._xml_response(xml)


@frappe.whitelist(allow_guest=True, methods=["GET", "POST"])
def customer_answer(call_log, token, role="customer", generation=0):
    return customer_callback(call_log, role, generation, token, "answer")


@frappe.whitelist(allow_guest=True, methods=["POST"])
def customer_ring(call_log, token, role="customer", generation=0):
    return customer_callback(call_log, role, generation, token, "ring")


@frappe.whitelist(allow_guest=True, methods=["GET", "POST"])
def reject(call_log, token, role="customer", generation=0):
    from vobiz_system_call.api import webrtc
    if not authorize(call_log, role, generation, token):
        return webrtc._plain_response("Not permitted.", 403)
    return webrtc._xml_response(webrtc._hangup_xml())


def apply_member(value, role, generation, uuid, action, now):
    """Monotonic per-leg membership: a delayed Enter never undoes an Exit."""
    if role == "customer":
        if action == "exit":
            value["customer_exited"] = True
            value["closed"] = True
        elif action == "enter" and not value.get("customer_exited"):
            value["customer_entered"] = True
        return
    leg = value.get("legs", {}).get(str(generation))
    if not leg or leg.get("uuid") != uuid:
        return
    if action == "exit":
        leg["exited"] = True
        if generation == value["generation"] and not value.get("deadline"):
            value["deadline"] = now + GRACE_SECONDS
    elif action == "enter" and not leg.get("exited") and not leg.get("ended"):
        leg["entered"] = True
        if generation == value["generation"] and (not value.get("deadline") or now < value["deadline"]):
            value["deadline"] = None


@frappe.whitelist(allow_guest=True, methods=["POST"])
def member(call_log, token, role, generation=0):
    from vobiz_system_call.api import webrtc
    generation = int(generation)
    if not authorize(call_log, role, generation, token):
        return webrtc._plain_response("Not permitted.", 403)
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    payload = webrtc._request_params()
    uuid = webrtc._provider_uuid(payload)
    action = str(payload.get("ConferenceAction") or "").lower()
    if not action:
        action = {"ConferenceEnter": "enter", "ConferenceExit": "exit"}.get(payload.get("Event"), "")
    if (payload.get("ConferenceName") != value.get("room") or action not in ("enter", "exit")
            or (role == "customer" and (int(generation) != 0 or uuid != row.call_uuid))
            or (role == "agent" and value.get("legs", {}).get(str(generation), {}).get("uuid") != uuid)):
        frappe.db.commit()
        return webrtc._plain_response("IGNORED")
    expired = stopped(row, value)
    apply_member(value, role, generation, uuid, action, time.time())
    if expired:
        value["closed"] = True
    save(row, value)
    if (role == "agent" and action == "enter" and not expired
            and generation == value["generation"] and current_leg(value).get("entered")
            and not current_leg(value).get("exited") and value.get("customer_issue") == "new"):
        frappe.enqueue("vobiz_system_call.api.conference.originate_customer", call_log=row.name,
                       queue=QUEUE, timeout=30, enqueue_after_commit=True,
                       job_id="vsc-conference-originate-" + row.name, deduplicate=True)
    enqueue(row.name, urgent=value.get("closed", False))
    frappe.db.commit()
    return webrtc._plain_response("OK")


@frappe.whitelist(allow_guest=True, methods=["POST"])
def ended(call_log, token, role="customer", generation=0):
    from vobiz_system_call.api import webrtc
    if role != "customer" or int(generation) != 0 or not authorize(call_log, role, generation, token):
        return webrtc._plain_response("Not permitted.", 403)
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    payload = webrtc._request_params()
    if (str(payload.get("Event") or "").lower() != "hangup"
            or not bind_customer(row, value, webrtc._provider_uuid(payload))):
        frappe.db.commit()
        return webrtc._plain_response("IGNORED")
    value.update(customer_ended=True, closed=True)
    save(row, value, call_uuid=row.call_uuid, recording_call_uuid=row.call_uuid)
    outcome = lifecycle.provider_outcome({"status": payload.get("CallStatus") or "completed",
                                         "hangup_cause": payload.get("HangupCause") or ""},
                                        bool(row.answer_time or webrtc._billable_seconds(payload)))
    lifecycle.finish_locked(mapping, row, "conference-customer-hangup", str(payload.get("HangupCause") or "")[:140],
                            status=outcome if outcome in lifecycle.TERMINAL else None)
    enqueue(row.name, urgent=True)
    frappe.db.commit()
    return webrtc._plain_response("OK")


def browser_event(mapping, row, event, reason, sdk_uuid, generation=0):
    value = state(row)
    leg = current_leg(value)
    # Browser UUIDs are evidence about the browser only, never the customer.
    if int(generation or 0) != value["generation"]:
        frappe.db.commit()
        return {"status": row.status, "conference_recovery": True}
    if event in ("onCallFailed", "onCallTerminated", "failed", "terminated", "hangup"):
        if not value.get("deadline"):
            value["deadline"] = time.time() + GRACE_SECONDS
        leg["browser_ended"] = True
        if leg.get("uuid"):
            leg["retire"] = True
        save(row, value, call_status="conference-agent-reconnecting")
        enqueue(row.name)
    elif event == "browserCallStarted":
        save(row, value, event=event)
    frappe.db.commit()
    return {"status": row.status, "conference_recovery": True}


def cancel(mapping, row):
    value = state(row)
    value["closed"] = True
    data = lifecycle.context(row)
    data["agent_cancelled"] = True
    data.setdefault("agent_cancel_requested_at", frappe.utils.now())
    row.request_json = json.dumps(data)
    save(row, value, call_status="cancellation-requested")
    frappe.db.commit()
    try:
        from vobiz_system_call.api import conference_jobs
        conference_jobs.enqueue(row.name, urgent=True, after_commit=False)
    except Exception:
        # Persisted intent and deadline dispatch remain. A queue outage must
        # not prevent the independent direct customer hangup attempt below.
        frappe.logger("vobiz_conference").exception("Unable to queue End Call for %s", row.name)
    # First customer hangup does not wait behind queued recovery/CDR work.
    # Only one bounded provider request runs in the web request; all leg cleanup
    # and confirmation are independently retried by the urgent workers.
    if row.call_uuid:
        try:
            client = VobizClient(get_settings())
            client.timeout = 3
            client.hangup_call(row.call_uuid, allow_missing=True)
        except Exception:
            pass
    current = frappe.db.get_value("Vobiz Call Log", row.name, "status")
    return {"status": current, "pending_provider": current not in lifecycle.TERMINAL}


def live_customer(row):
    if not row.call_uuid:
        return False
    client = VobizClient(get_settings())
    client.timeout = 3
    response = client.retrieve_live_call(row.call_uuid)
    for data in (response, response.get("data")):
        if not isinstance(data, dict):
            continue
        uuid = str(data.get("call_uuid") or data.get("uuid") or data.get("CallUUID") or "")
        status = str(data.get("call_status") or data.get("CallStatus") or data.get("status") or "").lower().replace("_", "-")
        if uuid == row.call_uuid and status in ("in-progress", "live", "ringing", "answered", "connected"):
            return True
    return False


@frappe.whitelist(methods=["POST"])
@rate_limit(key="call_log", limit=20, seconds=60)
def recover(call_log, tab_id, sdk_uuid="", media_connected=0, session_alive=0, generation=0):
    from vobiz_system_call.api import webrtc, ownership
    webrtc._login()
    mapping, row = lifecycle.lock_call(call_log)
    if row.user != frappe.session.user or ownership.current_owner(row.user, frappe.cache()) != tab_id:
        frappe.throw(_("This call belongs to another browser window."))
    value = state(row)
    if not value:
        return {"name": row.name, "status": row.status, "conference_recovery": False}
    if row.status in lifecycle.TERMINAL:
        frappe.db.commit()
        return {"name": row.name, "status": row.status, "conference_recovery": True}
    if mapping.current_call_log != row.name:
        frappe.throw(_("This is no longer your current call."))
    if stopped(row, value):
        value["closed"] = True
        save(row, value)
        enqueue(row.name)
        frappe.db.commit()
        return {"name": row.name, "status": row.status, "conference_recovery": True, "ending": True}
    leg = current_leg(value)
    if int(generation or 0) != value["generation"]:
        frappe.db.commit()
        return {"name": row.name, "status": row.status, "conference_recovery": True}
    # SDK session IDs and provider CallUUIDs are separate identities. The owned
    # browser reports media for its server-issued generation, never a PSTN ID.
    healthy = bool(frappe.utils.cint(media_connected) and sdk_uuid
                   and leg.get("entered") and not leg.get("exited") and not leg.get("ended")
                   and not leg.get("retire"))
    if healthy:
        value["deadline"] = None
        save(row, value)
        frappe.db.commit()
        return {"name": row.name, "status": row.status, "conference_recovery": True, "agent_connected": True}
    if not value.get("deadline"):
        value["deadline"] = time.time() + GRACE_SECONDS
        save(row, value)
    snapshot_uuid = row.call_uuid
    snapshot_generation = value["generation"]
    frappe.db.commit()
    # A surviving customer is verified before retiring an old SDK session.
    try:
        active = live_customer(row) if snapshot_uuid else value.get("customer_issue") == "new"
    except Exception:
        active = False
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    result = {"name": row.name, "status": row.status, "conference_recovery": True}
    if (stopped(row, value) or row.call_uuid != snapshot_uuid or value["generation"] != snapshot_generation
            or mapping.current_call_log != row.name
            or ownership.current_owner(row.user, frappe.cache()) != tab_id):
        frappe.db.commit()
        return result
    leg = current_leg(value)
    if not active:
        enqueue(row.name)
    elif frappe.utils.cint(session_alive):
        # Frontend hangs up the old browser session, then waits for its exit.
        # Customer survives because it is an independent provider call.
        result["retire_session"] = True
        leg["retire"] = True
        save(row, value)
        enqueue(row.name)
    elif leg.get("uuid") and not (leg.get("exited") or leg.get("ended")):
        leg["retire"] = True
        save(row, value)
        enqueue(row.name)
    else:
        if leg.get("uuid"):
            if len(value["legs"]) >= MAX_AGENT_LEGS:
                value["closed"] = True
                save(row, value)
                enqueue(row.name)
                result["ending"] = True
                frappe.db.commit()
                return result
            value["generation"] += 1
            value["route"] = "vsc" + secrets.token_hex(24)
        result.update(browser_join(row, value))
        save(row, value)
    watch(row.name)
    frappe.db.commit()
    return result


def reconcile(call_log):
    # Normal and urgent queues may both contain this call. Serialize provider
    # checks without blocking workers on a SQL lock throughout network I/O.
    cache = frappe.cache()
    lock = cache.lock(cache.make_key("vsc:conference-reconcile:" + call_log), timeout=150,
                      blocking_timeout=0)
    if not lock.acquire(blocking=False):
        return  # Registry leases retain the retry; cancellation intent is in SQL.
    try:
        _reconcile(call_log)
    finally:
        try:
            lock.release()
        except Exception:
            # Expired leases must not release a replacement worker's lock.
            pass


def _reconcile(call_log):
    """Retry termination and consult exact leg CDRs; absence is never proof."""
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    if not value:
        frappe.db.commit()
        return
    if stopped(row, value):
        value["closed"] = True
        save(row, value)
    snapshot = dict(row)
    closed = value.get("closed")
    legs = [(generation, dict(leg)) for generation, leg in value.get("legs", {}).items()]
    if closed and value.get("customer_issue") == "new":
        # The one-shot POST was never issued; the lock prevents it starting now.
        value["customer_ended"] = True
        save(row, value)
        lifecycle.finish_locked(mapping, row, "conference-cancelled-before-dial", status="Cancelled")
    frappe.db.commit()
    client = VobizClient(get_settings())
    client.timeout = 3
    targets = [("customer", snapshot.get("call_uuid"), closed)]
    targets += [(generation, leg.get("uuid"), closed or leg.get("retire"))
                for generation, leg in legs if not leg.get("ended")]
    confirmed = {}
    for role, uuid, terminate in targets:
        if not uuid:
            continue
        if terminate:
            try:
                client.hangup_call(uuid, allow_missing=True)
            except Exception:
                pass  # Retry via the registry; never release on HTTP failure.
        # Check live agent legs so lost membership callbacks cannot hold forever.
        leg = dict(legs).get(role, {})
        if role != "customer" and not terminate and not leg.get("exited"):
            try:
                client.retrieve_live_call(uuid)
                continue
            except Exception:
                pass  # A failure alone is not terminal; seek an exact final CDR.
        try:
            cdr = lifecycle.find_recovery_cdr(client, dict(snapshot, call_uuid=uuid))
            returned = str((cdr or {}).get("call_uuid") or (cdr or {}).get("uuid") or "")
            if cdr and returned == uuid and lifecycle.final_provider_cdr(cdr):
                confirmed[role] = (uuid, cdr)
        except Exception:
            pass
    mapping, row = lifecycle.lock_call(call_log)
    value = state(row)
    for role, (uuid, cdr) in confirmed.items():
        if role == "customer" and row.call_uuid == uuid:
            value.update(customer_ended=True, closed=True)
            save(row, value)
            frappe.db.commit()
            lifecycle.finish_reconciled_call(dict(row), cdr)
            mapping, row = lifecycle.lock_call(call_log)
            value = state(row)
        elif role in value["legs"] and value["legs"][role].get("uuid") == uuid:
            value["legs"][role]["ended"] = True
            value["legs"][role]["exited"] = True
            if int(role) == value["generation"] and not value.get("deadline"):
                value["deadline"] = time.time() + GRACE_SECONDS
    save(row, value)
    complete = value.get("customer_ended") and all(leg.get("ended") for leg in value["legs"].values())
    if not complete:
        watch(row.name)
    frappe.db.commit()


def on_call_update(doc, method=None):
    """Manual completion still needs cleanup of the independent provider legs."""
    if state(doc) and doc.status in lifecycle.TERMINAL:
        enqueue(doc.name, urgent=True)
