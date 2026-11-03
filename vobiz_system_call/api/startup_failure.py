"""Narrow local recovery for an identified, unestablished browser attempt."""
import json

from vobiz_system_call.api import lifecycle


# Explicit SIP rejection reasons, not transport timeouts, CANCEL or Q.850
# NORMAL_CLEARING. SDK 1.0.3 code is a Reason-header cause, not status_code.
SIP_REJECTIONS = frozenset((400, 401, 403, 404, 405, 406, 410, 415, 480, 484,
                            486, 488, 600, 603, 604, 606))


def evidence(value):
    if isinstance(value, str):
        if len(value) > 2048:
            return {}
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return {}
    if not isinstance(value, dict):
        return {}
    return {key: str(value.get(key) or "")[:140] for key in (
        "attempt_id", "phase", "originator", "protocol", "code", "state", "direction", "sdk_cause",
    )}


def confirmed(mapping, row, event, details, sdk_uuid):
    data = lifecycle.context(row)
    if (event != "onCallFailed" or mapping.get("current_call_log") != row.name
            or details.get("attempt_id") != row.name or row.get("direction") != "Outgoing"
            or not lifecycle.is_browser_call(row) or data.get("conference_recovery")
            or row.status not in ("Initiated", "Queued", "Ringing")
            or row.get("call_uuid") or row.get("b_leg_uuid") or row.get("answer_time")
            or data.get("browser_session_answered")
            or row.get("call_status") in ("onCallAnswered", "browser-audio-connected")):
        return False
    known_uuid = row.get("recording_call_uuid")
    if known_uuid and sdk_uuid != known_uuid:
        return False
    if details.get("phase") in ("pre-dial", "sdk-declined"):
        return not (sdk_uuid or known_uuid or row.get("call_status") in lifecycle.LOCAL_BROWSER_ACTIVE_STATUSES)
    if (details.get("phase") != "sdk-failure" or details.get("originator") != "remote"
            or details.get("direction") != "outgoing" or details.get("state") not in ("failed", "rejected")):
        return False
    # Bundled SDK/JsSIP maps only SIP 403/603 to this cause and sets REJECTED.
    # A SIP Reason header is optional, so code can legitimately be -1 here.
    if details.get("sdk_cause") == "Rejected" and details.get("state") == "rejected":
        return True
    try:
        code = int(details.get("code", ""))
    except (ValueError, TypeError):
        return False
    return details.get("protocol", "").upper() == "SIP" and code in SIP_REJECTIONS
