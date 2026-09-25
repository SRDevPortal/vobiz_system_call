"""User-scoped, idle-only browser handoff. Mapping locks serialize with call starts."""
from contextlib import contextmanager
import re
import secrets
import time

import frappe
from frappe import _

from vobiz_system_call.api import lifecycle


def owner_key(user):
    return "vsc:browser-owner:" + user


def transfer_key(user):
    return "vsc:browser-transfer:" + user


@contextmanager
def locked_browser(tab_id):
    from vobiz_system_call.api.webrtc import _login, _browser_enabled
    _login()
    if not _browser_enabled():
        frappe.throw(_("Browser calling is disabled."))
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", tab_id or ""):
        frappe.throw(_("Invalid browser window ID."))
    user = frappe.session.user
    mapping = lifecycle.lock_mapping(user)
    if not mapping.get("browser_softphone_enabled"):
        frappe.throw(_("Browser calling is disabled."))
    cache = frappe.cache()
    with cache.lock("vsc:presence-lock:" + user, timeout=5, blocking_timeout=2):
        yield user, mapping, cache
    frappe.db.commit()


def current_owner(user, cache):
    return cache.get_value(owner_key(user)) or lifecycle.presence(user)


def notify(user, data):
    frappe.publish_realtime("vobiz_softphone_ownership", data, user=user, after_commit=True)


def grant(user, tab_id, cache):
    # The durable owner prevents a suspended old tab from automatically reclaiming a lease.
    cache.set_value(owner_key(user), tab_id)
    cache.delete_value(transfer_key(user))
    lifecycle.set_presence(user, tab_id)
    notify(user, {"state": "granted", "tab_id": tab_id})
    return {"ownership": "granted", "registered": True}


def presence_heartbeat(tab_id, registered=1, claim_idle=0, call_log=None):
    with locked_browser(tab_id) as (user, mapping, cache):
        owner = current_owner(user, cache)
        if not frappe.utils.cint(registered):
            if lifecycle.presence(user) == tab_id:
                cache.delete_value("vsc:presence:" + user)
                if mapping.current_call_log:
                    cache.delete_value("vsc:active-call:" + mapping.current_call_log)
            return {"registered": False}
        pending = cache.get_value(transfer_key(user), expires=True)
        if pending:
            # A selected window may reload before the previous window has
            # released its lease. Resume that selection once the lease expires.
            if (frappe.utils.cint(claim_idle) and pending["new_tab"] == tab_id
                    and not mapping.current_call_log
                    and time.time() - pending["last_old_seen"] >= lifecycle.PRESENCE_SECONDS):
                return grant(user, tab_id, cache)
            if pending["old_tab"] == tab_id:
                pending["last_old_seen"] = time.time()
                cache.set_value(transfer_key(user), pending, expires_in_sec=90)
                return {"registered": False, "ownership": "release_requested",
                        "transfer_token": pending["token"], "tab_id": tab_id}
            return {"registered": False, "ownership": "other_window"}
        if owner and owner != tab_id:
            if mapping.current_call_log:
                return {"registered": False, "ownership": "active_call"}
            # The durable ID records ownership history, not current liveness.
            # Only a fresh connection may recover an idle, expired owner;
            # background heartbeats from superseded windows never reclaim it.
            if (frappe.utils.cint(claim_idle) and not mapping.current_call_log
                    and not lifecycle.presence(user)):
                return grant(user, tab_id, cache)
            return {"registered": False, "ownership": "other_window"}
        if not owner and mapping.current_call_log:
            return {"registered": False, "ownership": "active_call"}
        cache.set_value(owner_key(user), tab_id)
        lifecycle.set_presence(user, tab_id)
        if mapping.current_call_log:
            key = "vsc:active-call:" + mapping.current_call_log
            if call_log and call_log == mapping.current_call_log:
                cache.set_value(key, tab_id, expires_in_sec=90)
            else:
                cache.delete_value(key)
        return {"registered": True, "ownership": "granted"}


@frappe.whitelist(methods=["POST"])
def use_here(tab_id: str, transfer_token: str | None = None):
    """Request/poll an explicit switch; never evict a live or unresolved call."""
    with locked_browser(tab_id) as (user, mapping, cache):
        if mapping.current_call_log:
            return {"ownership": "active_call", "registered": False}
        owner = current_owner(user, cache)
        pending = cache.get_value(transfer_key(user), expires=True)
        if pending:
            if not transfer_token and owner == tab_id:
                # The current owner explicitly chose to keep calling here.
                # Cancel the pending transfer; its old token can no longer release us.
                return grant(user, tab_id, cache)
            if pending["new_tab"] != tab_id:
                if transfer_token:
                    return {"ownership": "superseded", "registered": False}
                # Latest explicit Use here wins. Polls carry a token and cannot
                # replace another request. Keep the old-owner logout/lease barrier.
                pending.update(new_tab=tab_id, token=secrets.token_urlsafe(24))
            if transfer_token and not secrets.compare_digest(transfer_token, pending["token"]):
                return {"ownership": "expired", "registered": False}
            if time.time() - pending["last_old_seen"] >= lifecycle.PRESENCE_SECONDS:
                return grant(user, tab_id, cache)
            pending["requester_seen"] = time.time()
            cache.set_value(transfer_key(user), pending, expires_in_sec=90)
            return {"ownership": "waiting", "registered": False, "transfer_token": pending["token"],
                    "old_tab": pending["old_tab"]}
        if owner == tab_id:
            return grant(user, tab_id, cache)
        if transfer_token:
            return {"ownership": "expired", "registered": False}
        if not owner or not lifecycle.presence(user):
            return grant(user, tab_id, cache)
        pending = {"old_tab": owner, "new_tab": tab_id, "token": secrets.token_urlsafe(24),
                   "last_old_seen": time.time(), "requester_seen": time.time()}
        cache.set_value(owner_key(user), owner)
        cache.set_value(transfer_key(user), pending, expires_in_sec=90)
        # Freeze new outbound/inbound reservations until old SDK logout or lease expiry.
        cache.delete_value("vsc:presence:" + user)
        notify(user, {"state": "release_requested", "tab_id": owner, "transfer_token": pending["token"]})
        return {"ownership": "waiting", "registered": False, "transfer_token": pending["token"], "old_tab": owner}


@frappe.whitelist(methods=["POST"])
def switch_status(tab_id: str, transfer_token: str):
    """Validate a realtime request before the old browser touches its SDK."""
    with locked_browser(tab_id) as (user, mapping, cache):
        pending = cache.get_value(transfer_key(user), expires=True)
        valid = (pending and pending["old_tab"] == tab_id and current_owner(user, cache) == tab_id
                 and secrets.compare_digest(str(transfer_token), pending["token"]))
        if not valid:
            return {"ownership": "expired"}
        return {"ownership": "active_call" if mapping.current_call_log else "release_requested"}


@frappe.whitelist(methods=["POST"])
def release_for_switch(tab_id: str, transfer_token: str, busy: int = 0):
    """Called by the old window only after SDK logout; reject stale acknowledgements."""
    with locked_browser(tab_id) as (user, mapping, cache):
        pending = cache.get_value(transfer_key(user), expires=True)
        if (not pending or pending["old_tab"] != tab_id
                or not secrets.compare_digest(str(transfer_token), pending["token"])
                or current_owner(user, cache) != tab_id):
            return {"ownership": "expired", "registered": False}
        if mapping.current_call_log or frappe.utils.cint(busy):
            cache.delete_value(transfer_key(user))
            lifecycle.set_presence(user, tab_id)
            notify(user, {"state": "blocked", "tab_id": pending["new_tab"]})
            return {"ownership": "active_call", "registered": False}
        return grant(user, pending["new_tab"], cache)
