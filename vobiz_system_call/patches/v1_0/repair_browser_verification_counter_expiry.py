"""Repair existing browser verification counters without resetting counts."""
from vobiz_system_call.browser_call_limits import repair_browser_verification_counter_expiry


def execute():
    return repair_browser_verification_counter_expiry()
