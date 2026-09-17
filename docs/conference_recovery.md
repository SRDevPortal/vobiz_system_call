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
  requests termination of customer and browser legs. Jobs retry unresolved
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

2. Merge this entry into the existing `workers` object in
   `sites/common_site_config.json`, preserving all other queues:

   ```json
   "vobiz_conference": {"timeout": 120, "background_workers": 1}
   ```

   Start a supervised worker for this queue:

   ```bash
   bench worker --queue vobiz_conference
   ```

   Use your normal process manager for a persistent production service. Worker
   capacity must be evaluated before expanding the pilot; one worker is not a
   claim of production call-center capacity.

3. Ensure the site's scheduler runs. Migration registers
   `vobiz_system_call.api.conference.sweep` every minute. The sweep records a
   heartbeat and queues due work. New pilot calls are refused before creating
   a Call Log if the sweep heartbeat is stale or its worker is unavailable.
   Monitor both services; a preflight check cannot prevent a later service outage.

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

To disable new conference calls for an agent, uncheck **Enable Call Recovery**
in their User Mapping and save. Keep the
code, callbacks, queue worker, and sweep running until existing conference calls
and their cleanup jobs are finished. Do not remove them while a customer leg
may still be connected.

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
