# Callback and retry reliability

## Local implementation

Deploy vobiz_system_call and vobiz_click_to_call together after staging
verification. This patch adds no database fields and changes no production settings.

- Outgoing Dial failure evidence can refine a provisional parent cancellation.
  Customer evidence is accepted only inside the authenticated per-call callback.
  Incoming agent legs, conference calls, answered calls, manual Completed results,
  and previously classified customer outcomes are not reclassified.
- A correction changes only the technical outcome and schedules derived reference
  updates. The separate vobiz_call_outcome_corrected event updates displayed
  information; it never reopens a call, advances Auto Dial or opens disposition.
- All VobizClient hangup callers share an account/UUID operation guard within the
  site. The first attempt is immediate. Subsequent attempts back off (30 seconds
  initially, capped at 120 seconds plus jitter), respecting longer Retry-After.
  Read cooldowns are separate. Deferred DELETE is not confirmation of termination.
- Temporary provider errors retain operation, HTTP status, source, retry delay and
  request ID. Call creation is not automatically retried after a timeout.
- The browser honors cancellation cooldowns. Failed attempts while locally offline
  can retry immediately when internet returns.
- Reference sync retains durable per-call markers and retries expected contention
  with jitter. Repeated contention logs are sampled per call (first and every
  eighth within an hour); other failures remain logged.
- Form capability/discovery requests share outstanding work, without permanently
  caching permission decisions. Navigating away ignores stale responses.

## Configuration

All three callback settings default to the existing 600 requests per endpoint,
observed source IP, per 60 seconds:

- vobiz_answer_requests_per_minute (answer and fallback)
- vobiz_event_requests_per_minute (provider_event and incoming_action)
- vobiz_hangup_requests_per_minute (hangup)

These settings use validated integers from 1 through 60000; absent/malformed
values fall back to 600. This range is a configuration bound, not a capacity
recommendation. Settings are evaluated per request from Frappe's loaded site
configuration. Reload long-lived services after configuration/deployment changes
using the site's normal deployment process.

Authentication remains mandatory and unchanged. These are bounded per-IP
allowances, not a new trusted-provider bypass. Do not increase them until traffic,
provider authentication, proxy identity and invalid-traffic behavior are verified.

The independent vobiz_provider_reads_per_minute setting retains default 120.
It is account-keyed within a site, not a cross-site account quota.
Frappe's optional site-wide rate_limit is another independent layer.

## Deployment and remaining verification

Use the normal bench build/migration/cache-clear/restart pipeline for both apps.
The asset URLs and page cache versions are bumped together. Preserve unresolved
call records during deployment and rollback; never clear reservations in bulk.

Local automated tests do not establish 400–500-agent capacity. Before production:
record deployed revisions and effective configuration, measure callback/queue/DB
latency, obtain Vobiz quotas and run staging load plus a controlled real-call
regression. Do not treat the resolved carrier incident as an application fix.

Reference-level work coalescing, database index changes, cross-site quota
coordination and higher callback allowances remain contingent on production
measurements. This patch does not claim to resolve every database bottleneck.
