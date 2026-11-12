"""Atomic fixed-window limit for browser call verification."""
from functools import wraps

import frappe

COMMAND = "vobiz_system_call.api.webrtc.verify_browser_call"
LIMIT = 12
WINDOW_SECONDS = 60

_COUNT = """
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) == -1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
"""

_REPAIR = """
if redis.call('PTTL', KEYS[1]) == -1 then
    return redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return 0
"""


def browser_verification_rate_limit(fn):
    """Preserve the legacy endpoint/IP/call key and count rejected attempts.

    No callback nesting exemption applies to this authenticated browser API.
    Redis failures propagate; healthy TTLs, including zero, are not extended.
    """
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not frappe.request:
            return fn(*args, **kwargs)
        ip = frappe.local.request_ip
        if not ip:
            frappe.throw(frappe._("Either key or IP flag is required."))
        call_log = frappe.form_dict.get("call_log", "")
        cache = frappe.cache
        key = cache.make_key(f"rl:{frappe.form_dict.cmd}:{ip}:{call_log}")
        count = int(cache.eval(_COUNT, 1, key, WINDOW_SECONDS * 1000))
        if count > LIMIT:
            frappe.throw(
                frappe._("You hit the rate limit because of too many requests. Please try after sometime."),
                frappe.RateLimitExceededError,
            )
        return fn(*args, **kwargs)
    return wrapper


def repair_browser_verification_counter_expiry():
    """Attach expiry only to this site's persistent verification counters.

    Preserve counts and existing timers. Safe to rerun after reloading workers.
    """
    cache = frappe.cache
    prefix = cache.make_key(f"rl:{COMMAND}:")
    if isinstance(prefix, str):
        prefix = prefix.encode()
    pattern = b"".join(b"\\" + bytes([c]) if c in b"*?[]\\" else bytes([c]) for c in prefix) + b"*"
    examined = repaired = 0
    for key in cache.scan_iter(match=pattern, count=200):
        raw = key.encode() if isinstance(key, str) else key
        if not raw.startswith(prefix):
            continue
        examined += 1
        repaired += int(cache.eval(_REPAIR, 1, raw, WINDOW_SECONDS * 1000))
    return {"examined": examined, "repaired": repaired, "window_seconds": WINDOW_SECONDS}
