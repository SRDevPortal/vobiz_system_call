# Browser heartbeat recovery

A slow or stalled call-status request previously held `browser_presence_check`
after the heartbeat had already succeeded. The next monitor ticks therefore
skipped presence refreshes. The server could expire browser presence even while
the agent still had the console open and working audio.

The console now releases that guard immediately after a successful heartbeat.
Status and recovery operations retain their own request guards. Normal heartbeat
cadence, contention retry, authentication rejection, and window ownership checks
are unchanged; no additional heartbeat timer is introduced.

The status lookup has a 10-second deadline using the existing timeout/abort
helper. A timeout leaves the call pending and does not hang up working audio.
Late results after timeout are ignored. Results from a replaced softphone client
or a different current call cannot reset the new session. A later normal poll
can retry the lookup.

## Validation

The network recovery suite includes regression cases for stalled status requests,
heartbeat deduplication and cadence, overlapping completion callbacks, timeout
and late-response handling, replacement clients, and pending conference/provider
recovery. The original source failed six of these regression cases.

Run the network recovery, presence contention, window handoff, incoming Pickup,
conference recovery, lifecycle, completion, readiness and End Call JavaScript
tests in `vobiz_system_call/tests`. They exercise the actual console source
without making provider calls.

The Pickup test fixture starts its presentation tests after the existing
asynchronous NDR/status/context checks and supplies matching status responses
when a queued disposition is rechecked. This changes test setup only.

## Deployment and temporary script removal

This correction is in `vobiz_system_call`; it requires no new schema or settings.
Deploy the app through the normal release process and clear the affected site's
Frappe cache. Verify the console page response contains the guard release before
status/recovery work and the bounded status lookup.

On SRIAAS, the temporary Server Script
`SRIAAS Temporary Console Heartbeat Recovery 20261118` remains enabled until the
permanent code is deployed. Its exact-match protection leaves this changed code
untouched. After verifying the deployed response, disable that script and verify
the normal page loader serves the permanent correction.

Agents already using the console retain their loaded JavaScript. Have them finish
their call and save their work before refreshing once. Wait for Registered;
agents intending to receive calls should select Available if still Offline.
Do not force-refresh active calls or mass-reset availability.

This fixes the reproduced heartbeat stall. It does not prove that every missing
Pickup report shares that cause; provider delivery, actual network loss, browser
suspension and incoming-call linking must still be monitored after deployment.
