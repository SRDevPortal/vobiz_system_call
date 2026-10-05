"""Private outbound browser routing; real destinations stay on the server."""
import hmac
import re
import secrets

import frappe
from vobiz_click_to_call import number_privacy
from vobiz_system_call.api import lifecycle

KEY = "private_browser_route"
HEADER = "X-VH-Private"


def digits(value):
    return re.sub(r"\D", "", str(value or ""))


def prepare(caller_id, customer_number):
    target = digits(caller_id)
    if not 8 <= len(target) <= 15 or target == digits(customer_number):
        raise frappe.ValidationError("A distinct Vobiz caller ID is required for private browser routing.")
    return {KEY: {"target": target, "token": secrets.token_hex(32)}}


def state(row):
    value = lifecycle.context(row).get(KEY)
    return value if isinstance(value, dict) else {}


def header(payload):
    for key, value in payload.items():
        normalized = str(key).lower().replace("-", "").replace("_", "")
        if normalized in ("xvhprivate", "sipheaderxvhprivate"):
            return str(value)
    return ""


def matches(row, raw_to, payload):
    from vobiz_system_call.api.webrtc import _number
    value = state(row)
    received = header(payload)
    return bool(value.get("target") and value.get("token") and received
                and digits(_number(raw_to)) == value["target"]
                and hmac.compare_digest(value["token"], received))


def browser_payload(row):
    value = state(row)
    if not value:
        if number_privacy.restricted(row.user):
            raise frappe.PermissionError("Start a new private browser call.")
        return {"destination": row.customer_number, "customer_number": row.customer_number}
    if (not value.get("token") or not value.get("target")
            or value["target"] != digits(row.caller_id)
            or value["target"] == digits(row.customer_number)):
        raise frappe.PermissionError("Invalid private browser route. Start a new call.")
    from privacy_shield.masking import mask_number
    return {"destination": value["target"], "customer_number": mask_number(row.customer_number),
            "private_browser_call": True, "conference_headers": {HEADER: value["token"]}}
