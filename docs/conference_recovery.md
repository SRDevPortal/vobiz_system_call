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
- The reconnect window is **120 seconds from detected agent loss**. Membership
  exit, a browser failure report, or an exact final browser-leg CDR can detect
  that loss. Detection and background scheduling add latency; this is not an
  exact 120-second carrier disconnect guarantee. The browser cannot report
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

## Deployment and activation

The new code is in `vobiz_system_call`. Migration adds the **Enable Call Recovery**
checkbox to the Browser Softphone section of Vobiz User Mapping. It defaults to
off. Existing unrelated local edits in other apps are
not part of this feature.

1. Back up the apps and site configuration. Deploy the app, build its assets,
   and run site migration to install the scheduler hook:

   ```bash
   bench build --app vobiz_system_call
   bench --site SITE migrate
   bench --site SITE clear-cache
   ```

2. Merge these entries into the existing `workers` object in
   `sites/common_site_config.json`, preserving all other queues:

   ```json
   "vobiz_conference": {"timeout": 120, "background_workers": 1},
   "vobiz_conference_end": {"timeout": 120, "background_workers": 1}
   ```

   Start separately supervised workers for these queues:

   ```bash
   bench worker --queue vobiz_conference
   bench worker --queue vobiz_conference_end
   ```

   Use your normal process manager for persistent production services. Do not
   combine these queues on one worker, or mix them with short/default/long.
   The worker counts above are a startup example, NOT capacity sizing for
   400–500 agents. Reserve CPU/memory and measure queue latency, provider API
   latency/limits and database load before choosing production worker counts.
   Separate hosts can isolate CPU/memory but still share SQL and Redis load.

3. Start a dedicated dispatcher for each site as a supervised CLI process:

   ```bash
   bench --site SITE execute vobiz_system_call.api.conference_jobs.run
   ```

   This command stays running. It is not an HTTP endpoint or a one-time setup
   command. Configure automatic restart and log rotation in Supervisor/systemd.
   It dispatches every second when idle, claims up to 1000 entries per index per
   pass, and performs no provider network requests. Batches can take longer
   under load. Recovery deadlines and End Call retries go to the urgent queue;
   ordinary checks/customer origination use the normal conference queue.
   Claimed work remains indexed with a retry lease if the dispatcher crashes.

   Keep the ordinary site scheduler running too. Its existing minute sweep is
   a backup, and does not make the dedicated dispatcher appear healthy.
   The dispatcher also rebuilds active-call timers from User Mapping in bounded
   batches once a minute. Configure Redis persistence: cleanup for calls already
   released from their mappings still depends on retained queue/watch data.

   After workers have consumed their probes, verify:

   ```bash
   bench --site SITE execute vobiz_system_call.api.conference_jobs.health
   bench --site SITE execute vobiz_system_call.api.conference.assert_ready
   ```

   Health must show `ready: true`; assert_ready must not raise an error.
   Both queues must execute a probe sent within 30 seconds, and the dispatcher
   heartbeat must be no older than 15 seconds. Old delayed probes cannot reopen
   admission. These checks reject NEW recovery calls; they never cancel existing
   calls or falsely confirm a hangup. Monitor queue age and service failures:
   preflight cannot prevent a later outage or guarantee a hard carrier deadline.

4. Open **Vobiz User Mapping**, select the agent, and expand **Browser Softphone**.
   Check **Enable Call Recovery** and save. Any mapped browser agent can be
   enabled this way by a user with permission to edit mappings; no site-config
   change is needed. Start with a small pilot. The setting affects new outgoing
   browser calls only. Incoming and Mobile Bridge calls keep their existing flow.

   When this field is first installed, any enabled legacy pilot allowlist is
   copied into the mapping checkboxes once. Later migrations do not overwrite
   choices made in the UI. The old `vsc_conference_recovery` and
   `vsc_conference_recovery_users` site-config values no longer control new calls.

   The endpoint must already use the app's authenticated WebRTC answer URL.
   Its SIP account and Vobiz Settings REST credentials must belong to the same
   Vobiz account. The webhook URL must remain reachable while the agent loses
   internet. Refresh the agent page after deployment.

5. Validate an ordinary outgoing call, browser disconnect/rejoin, customer
   hangup during recovery, End Call, recording playback, disposition, and the
   full timeout on the target site's provider account before expanding users.
   This changes call topology and adds conference/browser-leg usage; confirm
   billing and provider concurrency capacity before a broader rollout.

   Do not enable this across production merely because the code is deployed.
   Run the local dispatch/conference tests and then a controlled live pilot.
   Roll out 5 → 25 → 100 → remaining agents only after each stage passes:
   no duplicate customer origination, no premature disposition, correct End Call,
   full recordings, no significant ordinary ERP latency regression, and queue
   probe ages consistently inside the readiness threshold. Test mass disconnect,
   worker/process restart, provider timeouts and recovery after Redis interruption.
   Real account concurrency and call-start limits must support the test load.

To disable new conference calls for an agent, uncheck **Enable Call Recovery**
in their User Mapping and save. Keep the
code, callbacks, queue worker, and sweep running until existing conference calls
and their cleanup jobs are finished. Do not remove them while a customer leg
may still be connected.

### Upgrading from the original conference worker

Pause new recovery calls using the mapping checkbox and let active calls/cleanup
finish before upgrading services. The old single-worker heartbeat no longer
admits new recovery calls. Install both worker services and the dispatcher,
restart the web/worker processes to load the new code, verify health, then enable
one test mapping. No mapping is enabled or disabled automatically by this change.

To roll back, disable new recovery calls, retain the new services until their
cleanup work finishes, then restore the backed-up code/configuration. Do not
remove the urgent worker while it has pending termination jobs.

### Automated scale checks (not real-call capacity certification)

`test_conference_dispatch.py` starts a temporary isolated Redis on a Unix socket.
It verifies 500 simultaneous deadlines, a 1500-entry backlog, concurrent dispatch,
crash retry leases, queue failure, late probes and restoration of 500 active-call
timers. ERP SQL and provider operations in these tests are simulated. Conference
contract tests verify exact-call termination, no duplicate origination, no release
on an unconfirmed hangup, and stale deadline protection. These tests do not measure
500 live calls, carrier audio, provider throttling or production database capacity.

## Local validation — 17 September 2026

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
