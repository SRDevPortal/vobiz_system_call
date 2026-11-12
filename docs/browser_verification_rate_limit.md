# Browser call verification counter expiry

Production evidence showed two `verify_browser_call` counters at 628 and 242
with TTL -1. These are accumulated attempts, not one minute's traffic. This
route uses a separate limiter from provider callbacks and therefore requires
its own fix in `vobiz_system_call`.

The limiter now increments and initializes/repairs expiry in one Redis Lua
operation. It keeps the existing site/endpoint/IP/call key and limit of 12
requests per 60 seconds. Rejected attempts count; healthy timers are not
extended. A persistent over-limit counter remains blocked until its repaired
60-second window expires. Redis failures propagate, and login, call ownership,
System Manager access and provider-state verification are unchanged.

The registered migration scans only this site's exact verification endpoint
prefix and adds expiry only to persistent counters. Counts, healthy timers,
other sites, callback counters, sessions and provider-read budgets are untouched.
It is idempotent and also covers IPv6 identities without parsing their colons.

## Deployment

These instructions are not a record of deployment. Deploy the reviewed system
call revision to each affected bench. Deploy callback fix `107684d` in
`vobiz_click_to_call` as well to cover the separately reported provider counters.

For each affected site, run the normal migration:

```sh
bench --site SITE migrate
```

Reload all web and background workers using the deployment platform's normal
procedure (`bench restart` for a bench-managed deployment). Then repeat the
targeted repair to catch keys recreated by old workers during rollout:

```sh
bench --site SITE execute \
  vobiz_system_call.browser_call_limits.repair_browser_verification_counter_expiry
```

Replace SITE with `bhomeo.buopso.net` or `sriaas.butest.tech` as appropriate.
Wait 60 seconds and verify no matching persistent counters remain. Active keys
should have PTTL 0 through 60000; PTTL -2 means absent/expired. Check browser
recovery during an authorized test call: status verification should recover
after the window, and genuine excess requests should still receive HTTP 429.
Do not flush Redis. This does not fix the separate closed/stale log-file errors.

Rollback: redeploy the previous application revision and reload all workers.
No key format or database conversion is needed. The old limiter can recreate
the expiry defect; the migration alone is not a permanent fix.

## Validation

From the bench directory:

```sh
env/bin/python -m unittest \
  vobiz_system_call.tests.test_browser_call_limits -v
```

Tests require `redis-server` and start a temporary private Unix-socket server
with TCP and persistence disabled. They do not access site Redis or provider
services. They cover exact limits, concurrent and expiry-boundary requests,
stuck-counter recovery, IPv6/call/site isolation, scoped migration, Redis
failures, and the route's existing login and ownership checks.
