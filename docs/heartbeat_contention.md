# Browser heartbeat contention recovery

The production traceback on 17 November 2026 shows `browser_presence` waiting
for the agent's Vobiz User Mapping row until MariaDB error 1205. It also shows
an independent stale file handle while logging that exception. The traceback
does not identify the blocking transaction or prove a server process crash.

## Code change

- Only browser heartbeats opt into `SELECT ... FOR UPDATE NOWAIT`. Call starts,
  provider callbacks and explicit browser handoffs retain their existing locks.
- Redis presence-mutex acquisition is also nonblocking for this path. If either
  acquisition fails, roll back and return a retry response without changing the
  mapping, owner, presence expiry or active-call marker.
- The API uses HTTP 503 with `message.ownership = "retry"` and a suggested
  2,000 ms delay. This is an expected temporary contention response, not an
  unhandled exception. Cached clients see a temporary request failure instead
  of treating contention as a successful SDK claim or an ownership rejection.
- Updated browser code recognizes this response, preserves the SDK/call state,
  and retries on the next eligible monitor tick after 2–3 seconds of cooldown.
  It does not create diagnostic/recovery jobs just because a lock was busy.
- Identical in-flight heartbeat requests share one promise. Logout and fresh
  claim requests wait their turn and keep their original meaning.
- A fresh login blocked by contention fails safely with a retry message; it
  cannot start SDK login without a successful ownership check.
- Permission errors, real ownership rejection, unknown database errors and
  Redis lease loss after mutation are not swallowed as harmless contention.

This bounds the demonstrated lock-acquisition wait, not every possible request
delay. A prolonged database/storage outage can still expire presence leases.
It does not make an unavailable agent routable or mark a call complete.

## Validation

210 targeted Python tests passed, including a disposable MariaDB test with two
connections: hold the mapping row in one transaction, verify the other returns
promptly without cache changes, commit, then verify the retry sees the new
active call and refuses a competing browser claim. Three Node test scripts
passed for heartbeat retries, startup recovery and ringback behavior.

Tests ran on the local development environment, not a 500-agent production
load test. No production deployment or configuration changes were made.

## Deployment

Release the reviewed changes through the deployment's normal branch (Bharat
previously reported `frappe-15`; do not replace it blindly with `develop`).
Deploy Python and page JavaScript together, build assets, clear the site's cache,
and restart the actual managed web/worker processes. For the bench:

```bash
bench build --app vobiz_system_call
bench --site bhomeo.buopso.net clear-cache
```

Refresh agent pages after their active calls finish so the updated retry client
is loaded. No schema migration is introduced by this change. Check that a held
mapping produces a quick retry response and later heartbeats succeed, that
another window cannot take a live call, and that web-worker occupancy improves.

## Remaining production work

1. Capture the blocking transaction while the wait is occurring using DBA
   access to `information_schema.INNODB_LOCK_WAITS` and `INNODB_TRX`. Inspect
   the blocking connection's statements and application transaction boundaries.
   Shorten that specific critical section; do not kill unknown transactions or
   increase the global lock wait timeout as a substitute.
2. For the console-only logging deployment, set `FRAPPE_STREAM_LOGGING=1` in
   the environment of the actual web, scheduler and worker processes before
   startup, and restart those services. Setting it only in a bench console or
   site_config does not reconfigure existing file handlers. If file logs are
   required, repair the underlying mount/file handle issue instead.
3. Confirm installed process environments and logs after restart. This code
   change itself does not repair a stale filesystem handle.
