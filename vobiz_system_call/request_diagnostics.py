"""Token-free HTTP evidence for provider callbacks and softphone failures."""
import re
import logging
import time
import uuid

import frappe

METHODS = {
    "vobiz_system_call.api.webrtc." + name
    for name in ("answer", "hangup", "provider_event", "incoming_action", "browser_presence", "cancel_browser_call")
}
METHODS.add("vobiz_click_to_call.api.webrtc.answer")


def _method(request):
    path = getattr(request, "path", "")
    value = path.removeprefix("/api/method/") if path.startswith("/api/method/") else ""
    return value if value in METHODS else None


def before_request():
    if _method(getattr(frappe.local, "request", None)):
        frappe.local.vobiz_request_trace = (time.monotonic(), uuid.uuid4().hex)


def after_request(request=None, response=None):
    method = _method(request)
    if not method or response is None:
        return
    try:
        trace = getattr(frappe.local, "vobiz_request_trace", None)
        elapsed = round((time.monotonic() - trace[0]) * 1000) if trace else None
        trace_id = trace[1] if trace else uuid.uuid4().hex
        response.headers["X-Vobiz-Trace-Id"] = trace_id
        if method.endswith(".browser_presence") and response.status_code < 400 and elapsed is not None and elapsed < 1000:
            return  # Normal heartbeats need no per-agent request log.
        form = getattr(frappe.local, "form_dict", {}) or {}
        data = {
            "event": "vobiz_http_response", "method": method, "status": response.status_code,
            "elapsed_ms": elapsed, "trace_id": trace_id, "at": frappe.utils.now(),
            "actor": getattr(getattr(frappe.local, "session", None), "user", None),
        }
        for key in ("call_log", "CallUUID"):
            value = str(form.get(key) or "")
            if re.fullmatch(r"[A-Za-z0-9_-]{1,140}", value):
                data[key] = value
        # Deliberately exclude full URL, request/response bodies, tokens and headers.
        logger = frappe.logger("vobiz_http", allow_site=True, max_size=5_000_000, file_count=10)
        logger.setLevel(logging.INFO)
        logger.info(frappe.as_json(data))
    except Exception:
        pass  # Logging must never change the provider response.
