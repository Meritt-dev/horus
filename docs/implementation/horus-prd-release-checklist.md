# PRD 01/02 release checklist — October 4, 2026

Current private pilot: locally compiled CLI source `820126f` and Cloud API `0.0.115`.
Documentation commits do not change that executable or restart its soak. This
checklist covers PRD 01 and PRD 02's first usable release; subsequent trigger
providers, managed execution, Linux packaging and PRD 03 remain deferred.

Evidence scope matters: a passing hosted contract proves its assertions, not a
production incident. The 15 chronological recall labels measure source-reviewed
operation relevance, not human-confirmed causes. The preserved broad primary
checkpoint has not itself run in CI or been deployed.

## Verified source and contracts

- Horus source `820126f`: [push CI 37161742881](https://github.com/Meritt-dev/horus/actions/runs/37161742881) and [PR CI 37161746168](https://github.com/Meritt-dev/horus/actions/runs/37161746168), including workspace suites, chronological recall, build/smoke, hosted macOS launchd recovery and 1,406 Python checks.
- Cloud: [paired/unit/build CI 37161577626](https://github.com/Meritt-dev/horus-cloud/actions/runs/37161577626) and [51 browser cases 37161577657](https://github.com/Meritt-dev/horus-cloud/actions/runs/37161577657). The paired job pins `d6380d8`; final `820126f` differs only in a test fixture, with identical production code.
- Deployment and limitations: [runtime review-fix record](review-fixes-2026-10-04.md). Snyk could not scan because its private-test quota was exhausted.

## PRD 01

| Requirement | Evidence | Current limit |
| --- | --- | --- |
| M1 / A1: recall before collection | `startup-recall.test.ts` asserts prior check before broad collection; actual earlier worker report has positive startup recall | Current-revision fresh native run pending |
| M1 / A2: separate EMODA families | Same test separates stock/reserve, logger and supplier codes; 12/12 recurrence top-three and 3/3 unrelated no-match in hosted chronological holdout | Small relevance sample; no confirmed harmless-alert claim |
| M1 / A3: contradiction | Same test rejects historical certainty when current evidence contradicts it; history does not raise deterministic confidence | No fresh production contradiction case claimed |
| M2: outcome versus accuracy | Disposition/provenance schema and replication contracts; three private inferred EMODA annotations and bounded owner-attested 10-minute Redis TTL context | TTL/login design attestation does not confirm historical refresh/fetch failures as harmless |
| M3 / A5: offline/restart | `cloud/memory-sync.test.ts` reopens durable outbox and retries the same operation | No current-revision production outage with pending memory claimed |
| M3 / A6: lost acknowledgement | Authenticated paired API/profiles retain one receipt, recurrence and audit history after a lost response | Hosted controlled failure |
| M4 / A4: second machine | Paired clean editable profile; actual clean interserver profile restored 150 private IDs and fetched a large report without copying a database | Historical build; fresh interactive login and live correction writes not exercised there |
| M4 / A7: old update and clocks | Cloud replication tests retrieve old updates by server revision; original timestamps retained | Controlled contract |
| M4 / A8: conflicts/deletion | Paired corrections, tombstones and explicit restoration; mature history restores 2,101 links/2,102 audit rows after restart | Large-history production operation not claimed |
| M4 / A9: isolation | API owner/project checks, account-switch replica test and engine scope rejection | Hosted authorization cases |
| M3 / A10: adoption | Paired resumable report backfill; historical Maison adoption and current 154 Synced/zero pending status | Counts differ across dated checkpoints; do not compare them as one migration snapshot |
| M5 / A11: visible failures | Capture/sync failures retain useful reports; unreadable backfill rows remain pending; ownership fails closed | Production startup/sync latency percentiles unmeasured |
| M6: AI context | Worker prompt carries recall/provenance/evidence; model, report and citation validation; real earlier authenticated Opus reports | Jev remains disabled without measured improvement |

## PRD 02

| Requirement | Evidence | Current limit |
| --- | --- | --- |
| S1 / A1: login/restart | Hosted `test-service-launchd.ts` kills/restarts an isolated LaunchAgent and retains state | Owner confirms earlier manual logout/login on `faf3172`, not current-revision pending-job recovery |
| S1 / A2: sleep | Durable Cloud requests, lease expiry and offline heartbeat contracts | Owner confirms earlier sleep/wake on `faf3172`; queued-work recovery during that action unobserved |
| S2 / A3: duplicates | Event ledger, selected trigger and stable incident episode contracts; Slack is the result destination | Fresh native duplicate rate unmeasured |
| S2 / A4: recurrence | PagerDuty reopen, Sentry recur and Elasticsearch quiet-window replay assertions | Fresh native recurrence not observed |
| S2 / A5: retries/exhaustion | `watch-service.test.ts`, provider replay and Cloud lease tests group actual producer shapes by order/workflow across separate native IDs | No fresh production initial/retry/exhaustion sequence yet |
| S3 / A6: crash/checkpoints | Lease fencing, saved engine/AI/report/delivery stages, durable history cursor tests and hosted launchd restart | Full scenario soak still open |
| S3 / A7: competing claims | Cloud `alerts/leases.test.ts` races claimants and rejects stale completion | Hosted controlled race |
| S3 / A8: outages | Independent source/Cloud/Slack retry contracts, rate limits, durable notices and unknown-send receipts | Natural earlier Cloud poll recovery had no pending job; under-load scenario remains unobserved |
| S1 / A9: manual CLI contention | Crash-safe lock subprocess tests and worker ownership tests; no TTL takeover or unlocked fallback | Hosted real subprocess contention |
| S4 / A10: uncertain urgency | Worker/Slack contracts deliver zero-confidence uncertainty with a valid report link and next check | One dated real Slack report delivered; fresh automatic native result pending |
| S6 / A11: limits | Daily budget deferral/notices and subprocess group cancellation tests | Temporary caps derived from seven-day native history; current live rates unmeasured |
| S5 / A12: sources | Signed native PagerDuty, Sentry and Elasticsearch hosted replay; active Maison subscription and actual earlier Elasticsearch reports | No live Sentry activation claimed; Azure/AWS/Grafana triggers remain later scope |
| S4 / A13: local Claude | Exact argv/stdin assertions and real earlier Opus 5.5 sessions under the user's configured local authentication | Hosted failure coverage uses controlled executable output |
| S4 / A14: AI failure | Model/citation/identity rejection, bounded retries, preserved engine report and descendant termination assertions | No new fault injection on the Mac |
| S4 / A15: environment/session | Explicit runtime/auth paths, fresh session identity and actual earlier launchd invocation | Owner's prior physical actions do not attest every current session scenario |
| S6: observability | Cloud SSE activity/isolation/revocation contracts; durable run timeline; Cloud-selected Slack app destination | Idle worker correctly has no new activity; captured timeline is bounded, not a full transcript |

## Open public-release gates

- Fresh native PagerDuty acceptance → local worker → validated report → Cloud-selected `#maison-agent-runs`, then measured start latency, failure and duplicate rates. October 4 reads show an active subscription, no open incidents, newest displayed incidents dated September 27, and no Cloud-native requests.
- Full 72-hour scenario soak for the final combination, including recovery and delivery scenarios. Earliest elapsed cutoff: October 7, 02:47:57 Istanbul. Time alone is insufficient. Earlier manual sleep/wake and logout/login are accepted; no repetition is requested.

The worker remains installed for normal real-project operation. No local unit,
end-to-end, integration, replay or lifecycle scripts run. Private current-state
receipts: `~/.horus/deployments/prd-continuation-20261004/`.
