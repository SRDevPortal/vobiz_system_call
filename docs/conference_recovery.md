# Outgoing browser-call conference recovery

This optional mode keeps the customer in a Vobiz conference when the agent's
browser leg disconnects. The browser may join that same room again. Recovery
does not issue another customer call. Incoming calls and agents without recovery
enabled in their Vobiz User Mapping use the existing flow.

## Behavior and guarantees

- Each logical call has a private room and a separate browser-join token.
  The browser dials through its endpoint's existing application with the
  `X-VH-VSC` header. The authenticated answer handler returns conference XML,
  never a customer `Dial`, for these requests.
- The customer REST request is issued once, after the browser enters the room.
  Its intent is committed before provider I/O. A timeout is an unknown outcome,
  not permission to issue the customer request again.
- The Call Log provider UUID belongs to the customer. Browser leg UUIDs and
  monotonically increasing generations are recorded separately in
  `request_json.conference_recovery`. A REST request UUID is not blindly used
  as a customer call UUID.
- `stayAlone=true` and `endConferenceOnExit=false` keep the remaining member
  connected. Each browser rejoin is matched to its call token, generation,
  endpoint, owner window, and current mapping.
- The reconnect window is **60 seconds from detected agent loss**. Membership
  exit, a browser failure report, or an exact final browser-leg CDR can detect
  that loss. Detection and background scheduling add latency; this is not an
  exact 60-second carrier disconnect guarantee. The browser cannot report
  while offline. The provider call/conference time limit remains an additional
  ceiling (Vobiz Settings `max_call_duration`, default 3600 seconds, capped at
  14400 seconds).
- End Call records intent before browser hangup, prevents further rejoins, and
  attempts the customer hangup directly with a three-second request timeout.
  A separate urgent queue requests termination of customer and browser legs
  and retries unresolved
  termination. A timeout, a missing live-call result, or successful DELETE alone
  does not release the agent or open disposition. An authenticated customer
  hangup or exact final customer CDR does.
- Disposition uses the existing confirmed-completion flow. A customer hangup
  during recovery closes the recovery attempt. Old browser callbacks cannot
  complete the customer's call or cancel a newer call.
- Recording is on the enduring customer session, using the existing recording
  callback and authenticated ERP playback. Rejoining does not start a second
  customer recording. Vobiz's conference `record` attribute is not used.
- If a provider create request has an unknown outcome and no authenticated call
  ID arrives, the app retains that uncertainty. It cannot safely guess a call ID
  or declare termination. This mode requires working provider callbacks and
  CDR access, just like ordinary verified termination.

## Deployment and activation — existing Frappe workers

This mode uses the standard queues already provided by Frappe:
- `default`: customer origination and routine recovery checks.
- `short`: End Call cleanup, expired reconnect deadlines and confirmed customer-end cleanup.
- The existing Frappe scheduler invokes `conference.sweep` every minute.
  The sweep does bounded Redis/SQL work and enqueues jobs; it does not sleep or
  make provider network requests.

No custom queues or separate conference dispatcher are required. The agent's
**Enable Call Recovery** checkbox remains opt-in and defaults to off. This code
does not enable any agent, start processes, or change worker allocation.

1. Back up and deploy `vobiz_system_call` through the normal app deployment.
   Run migration, then restart the site's web and existing workers so they all
   use the same code:

   ```bash
   bench --site SITE migrate
   bench --site SITE clear-cache
   ```

   Migration updates the mapping description to the 60-second reconnect window
   and registers the existing minute scheduler hook. No custom worker entries
   need to be added to `common_site_config.json`.

2. Ensure the existing Frappe scheduler and normal workers are operating.
   In Scheduled Job Type, `vobiz_system_call.api.conference.sweep` must not be
   stopped. Enabling the scheduler does not start a missing OS process:

   ```bash
   bench --site SITE enable-scheduler
   bench doctor
   ```

   After at least one scheduled sweep and completion of the worker probes:

   ```bash
   bench --site SITE execute vobiz_system_call.api.conference_jobs.health
   bench --site SITE execute vobiz_system_call.api.conference.assert_ready
   ```

   Health should report `scheduler`, `default`, `short` and `ready` as true.
   The sweep heartbeat and completed probes expire after 150 seconds of
   inactivity. Each probe must have waited no more than 30 seconds to execute.
   An old delayed probe cannot make an overloaded queue appear healthy.
   Only NEW recovery calls are refused when health fails; ongoing cleanup and
   direct End Call remain available. Preflight cannot prevent a later outage.

3. In **Vobiz User Mapping → Browser Softphone**, enable **Enable Call Recovery**
   for one test agent. The endpoint and Vobiz Settings must belong to the same
   provider account, and the provider callback URL must stay online when the
   agent loses internet.

4. Test ordinary calling, disconnect/rejoin before the deadline, remaining offline
   beyond the deadline, End Call, recordings and disposition before expanding.
   Start with 5 agents, then 25, then 100, then the rest only if each stage passes.
   Monitor existing ERP queue delays, CPU, database load and Vobiz concurrency/CPS.

### Timing and shared-worker limitations

The 60-second window starts when agent loss is detected, not necessarily the
instant physical connectivity disappears. A rejoin received after the stored
deadline is refused, and cleanup is requested. A browser that stays offline
cannot send further requests, so cleanup is dispatched by the next scheduled
sweep. Its nominal cadence is one minute; Frappe's scheduler tick and worker
backlogs can add further delay. **This is not a guarantee of disconnection at
exactly 60 seconds.** Workers do not sleep for 60 seconds waiting for a call.

End Call persists intent, attempts the exact customer hangup directly, and queues
cleanup on `short`. Termination/disposition still require verified call-end
evidence. Standard `short` workers also handle other ERP jobs, so cleanup can
wait behind those jobs; there is no reserved worker or preemption. Jobs use FIFO
rather than moving mass recovery work ahead of unrelated ERP jobs.

Up to 1000 due entries per index can be claimed per sweep. Retry leases retain
work if enqueueing fails or a scheduler job stops, and active mapped calls are
rebuilt in bounded batches after cache loss. Claims beyond a batch wait for a
later sweep. Redis persistence is still required for historical pending cleanup
whose mapping has already been released. A fresh health check is not capacity
certification for 400–500 real calls.

### Upgrading from dedicated conference workers

Disable new recovery calls and drain existing conference calls/cleanup before
switching deployed processes to this version. Existing jobs may remain in the old
`vobiz_conference` / `vobiz_conference_end` queues: do not stop their old consumers
until those queues and active jobs are drained. New jobs use `default` / `short`.
The old `conference_jobs.run` entry point is retained for compatibility but is
no longer required; stop that extra process once the normal scheduler has taken
over and its health checks pass.

Existing stored deadlines are not rewritten by deployment. Newly calculated
reconnect windows are 60 seconds. Repeated disconnect notifications do not extend
the deadline. Disabling a mapping affects new calls; keep standard workers,
callbacks and the scheduler running until existing recovery calls are finished.

### Automated checks

`test_conference_dispatch.py` starts isolated Redis and verifies 500 simultaneous
deadlines, concurrent dispatch, claim retries, failed queues, late health probes,
and rebuilding 500 active-call timers. A real RQ worker consumes the standard
`short` queue while 500 `default` jobs remain waiting. Conference tests exercise
60-second expiry, rejoin races, End Call, no duplicate customer origination and
no premature disposition. SQL/provider operations are simulated; this is not a
500-live-call or production-performance test.

## Historical live-call validation — 17 September 2026 (original 120-second mode)

Backup and private evidence:
`/home/jagmohan/.codex-work/conference-resume-20260917-065433`.

The local pilot enables only `vobiz.test001@vobiz-test.invalid`. All normal users
remain on their existing call flow. Live ERP sites were not changed. Local
background jobs for this pilot use the isolated `vobiz_conference` worker and a
temporary conference-only sweep process; the previously disabled global site
scheduler was not enabled. These development processes must be supervised or
replaced with the deployment services above for persistent operation.

The real recovery test used call log `CTC-MRwVYnoSU4y2CGJEQXgjB_m_`:

- Browser HTTP went offline for 25 seconds and its PeerConnection was closed
  to ensure audio interruption. The ERP server and tunnel stayed online.
- An independent provider read confirmed the customer was still live during
  that interruption. The same customer UUID remained throughout recovery.
- Generation 2 joined the existing room. The customer confirmed the mobile
  stayed connected and the test tone returned.
- End Call produced an exact final customer CDR with `hangup_source=API Request`.
  Both browser legs also have final CDRs. The agent ended Offline with no current
  call, and the conference cleanup registry was empty.
- Disposition opened and saved; its agent, timestamp, and notes were checked in
  the database. One customer recording was completed and streamed successfully
  through the ERP (HTTP 200, audio/mpeg, 369216 bytes), decoded as 92.04 seconds.
- A preceding customer call ended when the customer deliberately hung up.
  It correctly completed, opened disposition, and closed recovery.
- Early SIP-only attempts exposed an unsupported arbitrary SIP route. That
  approach was replaced with the verified `X-VH-VSC` application header. Those
  attempts issued no customer calls and are retained in private test evidence.

This is a controlled browser/media interruption test, not a physical Wi-Fi
switch-off test, a 500-agent load test, or proof across every carrier/network.
Full 120-second expiry and concurrent races have automated coverage; expiry
has not yet been observed on a real held customer call. Browser console entries
include expected offline request failures and existing socket.io timeouts;
the successful pilot had no page exceptions or HTTP error responses.

Official provider reference:
[Conference attributes](https://www.vobiz.ai/docs/xml/conference/attributes),
[Conference callbacks](https://www.vobiz.ai/docs/xml/conference/conference-callbacks).
