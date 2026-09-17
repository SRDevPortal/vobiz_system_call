"""Conference recovery on standard Frappe queues and the existing scheduler.

The minute sweep dispatches due work without sleeping or doing provider I/O.
Call events and explicit End Call enqueue immediately between scheduled sweeps.
"""
from __future__ import annotations

import time

import frappe

NORMAL_QUEUE = "default"
URGENT_QUEUE = "short"
WATCH = "vsc:conference-watch"
DEADLINES = "vsc:conference-deadlines"
URGENT = "vsc:conference-urgent"
SCHEDULER_HEARTBEAT = "vsc:conference-scheduler-v3"
PROBE_PREFIX = "vsc:conference-probe-v3:"
BATCH_SIZE = 1000
RETRY_SECONDS = 5
PROBE_INTERVAL = 10
MAX_PROBE_AGE = 30
MAX_HEARTBEAT_AGE = 150  # The existing scheduler runs the sweep every minute.

# Earlier work must never be postponed by a delayed ordinary callback.
_WATCH = """
local old = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not old or tonumber(ARGV[2]) < tonumber(old) then
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
end
return 1
"""

# Claim with a lease, rather than remove: a dispatcher crash cannot lose work.
_CLAIM = """
local names = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
for _, name in ipairs(names) do
    redis.call('ZADD', KEYS[1], ARGV[2], name)
end
return names
"""


def watch(name, delay=30, urgent=False):
    cache = frappe.cache()
    cache.eval(_WATCH, 1, cache.make_key(URGENT if urgent else WATCH), name, time.time() + delay)


def schedule_state(name, value):
    """Register only committed state; stale timer delivery is rechecked in SQL."""
    complete = value.get("customer_ended") and all(
        leg.get("ended") for leg in value.get("legs", {}).values())
    deadline = min((t for t in (value.get("deadline"), value.get("expires_at")) if t), default=None)
    closed = bool(value.get("closed"))

    def register():
        try:
            cache = frappe.cache()
            if complete:
                forget(name)
            elif closed:
                cache.zrem(cache.make_key(DEADLINES), name)
                watch(name, RETRY_SECONDS, urgent=True)
            elif deadline:
                cache.zadd(cache.make_key(DEADLINES), {name: deadline})
        except Exception:
            # SQL is already committed. Do not block direct End Call on a cache
            # failure. The dispatcher rebuilds active calls from mapping rows.
            frappe.logger("vobiz_conference").exception("Unable to index conference %s", name)

    frappe.db.after_commit.add(register)


def forget(name):
    cache = frappe.cache()
    for key in (WATCH, DEADLINES, URGENT):
        cache.zrem(cache.make_key(key), name)


def enqueue(name, urgent=False, after_commit=True):
    # Different IDs let End Call bypass an already queued ordinary check.
    watch(name, 0, urgent=urgent)
    return frappe.enqueue(
        "vobiz_system_call.api.conference.reconcile", call_log=name,
        queue=URGENT_QUEUE if urgent else NORMAL_QUEUE, timeout=120,
        enqueue_after_commit=after_commit,
        job_id=("vsc-conference-end-" if urgent else "vsc-conference-") + name,
        deduplicate=True,
    )


def worker_probe(queue_name, sent_at):
    if queue_name not in (NORMAL_QUEUE, URGENT_QUEUE):
        return
    # Arrival freshness alone is insufficient: measure how long this job waited.
    frappe.cache().set_value(PROBE_PREFIX + queue_name,
        {"sent_at": float(sent_at), "completed_at": time.time()}, expires_in_sec=180)


def health():
    from frappe.utils.background_jobs import get_queues_timeout
    now = time.time()
    cache = frappe.cache()
    configured = get_queues_timeout()

    def fresh(key, age):
        try:
            stamp = float(cache.get_value(key, expires=True))
            return 0 <= now - stamp <= age
        except (TypeError, ValueError):
            return False

    result = {"scheduler": fresh(SCHEDULER_HEARTBEAT, MAX_HEARTBEAT_AGE)}
    for queue in (NORMAL_QUEUE, URGENT_QUEUE):
        probe = cache.get_value(PROBE_PREFIX + queue, expires=True)
        try:
            sent = float(probe["sent_at"])
            completed = float(probe["completed_at"])
            healthy = (0 <= completed - sent <= MAX_PROBE_AGE
                       and 0 <= now - completed <= MAX_HEARTBEAT_AGE)
        except (TypeError, KeyError, ValueError):
            healthy = False
        result[queue] = queue in configured and healthy
    result["ready"] = all(result.values())
    return result


def dispatch_due():
    """Bounded batches per tick; urgent work does not sit behind routine checks."""
    cache = frappe.cache()
    now = time.time()
    counts = {}
    seen = set()
    for key, urgent in ((URGENT, True), (DEADLINES, True), (WATCH, False)):
        lease = RETRY_SECONDS if urgent else 30
        names = cache.eval(_CLAIM, 1, cache.make_key(key), now, now + lease, BATCH_SIZE)
        counts[key] = len(names)
        for raw in names:
            name = raw.decode() if isinstance(raw, bytes) else raw
            if name in seen:
                continue
            seen.add(name)
            try:
                # Do not reinsert at time zero: retain the claim lease on success.
                frappe.enqueue(
                    "vobiz_system_call.api.conference.reconcile", call_log=name,
                    queue=URGENT_QUEUE if urgent else NORMAL_QUEUE, timeout=120,
                    job_id=("vsc-conference-end-" if urgent else "vsc-conference-") + name,
                    deduplicate=True,
                )
            except Exception:
                # Lease expires automatically. Continue dispatching other calls.
                frappe.logger("vobiz_conference").exception("Conference dispatch failed for %s", name)
    return counts


def tick():
    cache = frappe.cache()
    if cache.set(cache.make_key("vsc:conference-rebuild-throttle-v2"), "1", nx=True, ex=60):
        rebuild_active()
    result = dispatch_due()
    # Probes are ordinary FIFO work, never privileged ahead of a stalled queue.
    if cache.set(cache.make_key("vsc:conference-probe-throttle-v2"), "1", nx=True, ex=PROBE_INTERVAL):
        for queue in (NORMAL_QUEUE, URGENT_QUEUE):
            try:
                frappe.enqueue(
                    "vobiz_system_call.api.conference_jobs.worker_probe", queue=queue,
                    timeout=10, job_id="vsc-probe-v2-" + queue, deduplicate=True,
                    sent_at=time.time(), queue_name=queue,
                )
            except Exception:
                # An overloaded ordinary queue must not prevent urgent dispatch.
                frappe.logger("vobiz_conference").exception("Conference probe failed for %s", queue)
    frappe.db.commit()
    cache.set_value(SCHEDULER_HEARTBEAT, time.time(), expires_in_sec=180)
    return result


def rebuild_active():
    """Restore active-call timers after cache loss; bounded mapping keyset scan."""
    from vobiz_system_call.api import conference
    cache = frappe.cache()
    cursor = cache.get_value("vsc:conference-rebuild-cursor-v2", expires=True) or ""
    mappings = frappe.get_all(
        "Vobiz User Mapping", filters={"name": [">", cursor]},
        fields=["name", "current_call_log"], order_by="name asc", limit_page_length=BATCH_SIZE)
    names = list({m.current_call_log for m in mappings if m.current_call_log})
    if names:
        rows = frappe.get_all("Vobiz Call Log", filters={"name": ["in", names]},
                              fields=["name", "request_json"], limit_page_length=BATCH_SIZE)
        for row in rows:
            value = conference.state(row)
            if value:
                schedule_state(row.name, value)
                watch(row.name)
    # Move the cursor only after the database work succeeds.
    cache.set_value("vsc:conference-rebuild-cursor-v2",
                    mappings[-1].name if len(mappings) == BATCH_SIZE else "", expires_in_sec=3600)


def run():
    """Legacy dispatcher compatibility only; new deployments use the scheduler."""
    while True:
        started = time.monotonic()
        try:
            tick()
        except Exception:
            frappe.db.rollback()
            frappe.logger("vobiz_conference").exception("Conference dispatcher tick failed")
        time.sleep(max(0.1, 1 - (time.monotonic() - started)))
