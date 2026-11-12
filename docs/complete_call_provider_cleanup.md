# Complete Call: provider hangup with an independent local release

## Behavior

Only an explicit Complete Call button request starts this flow. It does not
automatically end an agent's call after 60 seconds or start a replacement call.
The separate verification rate-limit fix is unchanged.

The button checks login, ownership, browser-call context, and current mapping.
It records cancellation intent and a durable Pending recovery record, commits
the transaction to release database locks, then attempts one hangup of the
first authenticated provider ID. The existing account/UUID cooldown still
applies. The client uses 2-second connect and read timeouts; there is no inline
polling or retry loop. These are socket timeouts, not a guaranteed wall-clock
deadline (DNS and platform delays can add time).

After the attempt, it locks and revalidates ownership/current call again. It
performs the existing local reset even when the provider request failed,
timed out, was deferred by the shared cooldown, or lacked a verified ID. Busy
becomes Available; Offline/Away selections and newer call reservations remain
unchanged. The browser retires its old SDK session and reconnects for the next
call. Retry Call still requires another deliberate click.

An unfinished local call remains Cancelled with `agent-local-reset`. Existing
final outcomes, timestamps, billing and hangup causes are preserved. A local
reset or successful DELETE does not fabricate a Completed provider outcome.
The UI explicitly says when the previous call's end is unconfirmed.

## Background verification

Two read-only Call Log fields track independent provider cleanup:
`completion_provider_status` (Pending, Confirmed, Needs Review) and
`completion_provider_due`. An index supports bounded due-work selection.
The request JSON `complete_provider` object stores button intent, attempts,
verified IDs and bounded outcome labels, not credentials or raw errors.

After commit, a short-queue job is attempted. The minute scheduler dispatches
up to 100 due SQL records, so queue/cache loss does not discard recovery intent.
A 150-second SQL lease prevents concurrent workers; a killed worker can be
retried after the lease. Workers do not sleep, hold database locks over network
I/O, or change agent mappings or emit late disconnect events.

Each pass checks at most four known legs, including authenticated customer and
conference IDs. It uses the existing provider read budget and hangup cooldown.
Exact final CDRs are required to confirm those legs. HTTP 404, an accepted
hangup, missing data and timeouts are not proof of termination. A browser-only
SDK ID must match endpoint, destination, ID and call creation time before a
hangup or final confirmation is allowed. Newly arrived IDs remain pending.

There are at most eight background passes with backoff (1, 2, 4, 8, then
15 minutes between unresolved passes, subject to queue/scheduler delay).
Persistent failures or missing identities end in Needs Review. They never
reserve the agent again. Provider confirmation covers the known identified
legs; billing/customer-outcome synchronization remains the existing CDR flow.
No provider call can be guaranteed terminated while Vobiz is unreachable.

## Examples

Before: the customer call is still active, but the agent's browser loses its
connection. Complete Call clears Frappe's Busy state without requesting a
server-side hangup. The old provider call may continue.

After: the agent clicks the same button. Frappe attempts an exact old-call
hangup, releases the agent locally and checks final evidence in the background.
If Vobiz is unavailable, the UI reports an unconfirmed end while allowing work
to continue. A later job can retry the old call; it cannot release or hang up
a newer call by following the agent's current mapping.

## Deployment

This is a runbook, not a production deployment record.

1. Deploy this system-call revision through the normal deployment process.
2. Run `bench --site SITE migrate` to create the two custom fields, index and
   scheduler hook. This adds fields/indexes to the Call Log table; run the
   migration under the site's normal schema-change procedure.
3. Run `bench build --app vobiz_system_call`, clear the site's cache and restart
   all web, scheduler and short/default workers using the deployment platform's
   process. On a bench-managed deployment use `bench restart`.
4. Replace the existing temporary Server Script body with
   `complete_call_server_script.py` in this directory, preserving its original
   body as a rollback copy, or disable that override after validating the native
   compatibility endpoint. Keep Allow Guest OFF. Do this only after the new
   endpoint is deployed; calling the old overridden endpoint from itself would
   recurse. The new button directly calls `complete_call_from_button`, avoiding
   the legacy override; the wrapper covers older open browser tabs.
5. Reload the console. The asset/page version is `20261112.1`.
6. Use an authorized test call to check normal provider termination, provider
   timeout with local release, queue failure with later scheduled recovery, and
   a new call started before the old verification finishes. Verify the old
   Call Log's confirmation fields and that the new call is untouched.

SITE is the site being deployed (for this request, `sriaas.butest.tech`).
No live Server Script or production configuration was changed by this patch.

Rollback: restore the previous app revision and saved Server Script, rebuild
assets and reload workers. The added fields can remain; they do not change
call routing by themselves. Old queued verification jobs are safe on the prior
revision, where `verify_completion` is a no-op. Pending cleanup will not advance
while the old code is deployed; record that before rollback.

## Local checks

```sh
env/bin/python -m unittest \
  vobiz_system_call.tests.test_complete_retry \
  vobiz_system_call.tests.test_completion_provider \
  vobiz_system_call.tests.test_install_indexes -v
node --test \
  apps/vobiz_system_call/vobiz_system_call/tests/test_manual_complete.cjs \
  apps/vobiz_system_call/vobiz_system_call/tests/test_browser_completion.cjs
```

These tests mock provider calls and database operations; no real calls are
ended. A live migration and provider test remain deployment checks.
