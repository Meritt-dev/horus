# Incident memory and the macOS investigation service

This release extends the engine memory store, shared investigation runner, watcher,
Cloud memory service, and Cloud alert queue. Cloud accepts work; your Mac executes
it. PRD 03, Azure/AWS/Grafana trigger adapters, Linux packaging, managed execution,
and Jev ranking are outside this change.

## Deploy the paired versions

Deploy Horus Cloud with migrations `0034_memory_revisions`, `0035_alert_leases`,
`0036_pagerduty_details`, and `0037_worker_activity`
before activating this CLI. Use the repository's existing migration and deployment
process; do not point the CLI at Cloud Postgres. Local migrations `0013_memory_sync`
and `0014_watch_jobs` apply automatically when the embedded database opens.

Configure Cloud's existing private object storage before adopting large histories:
`STORAGE_BUCKET`, `STORAGE_REGION`, and the server's AWS credentials or workload role.
For an S3-compatible endpoint also set `STORAGE_ENDPOINT` and
`STORAGE_FORCE_PATH_STYLE=true`. Saved report bodies above 256 KB use that store;
without it, sync stays pending with an actionable error. Do not truncate evidence
or raise the inline limit to make the error disappear. Connector credentials belong
on the local executor, separately from Cloud's storage credentials.

From the Horus checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @merittdev/horus build
node apps/horus/dist/index.cjs --help
```

For each project, use the existing `horus login` and `horus cloud link` flows under
the local macOS user who will own the service. Verify the selected organization,
workspace, project, and environment. Existing local runtime connector credentials
and read-only access policies remain authoritative.

## Memory

Investigations refresh memory before collection, surface up to three relevant
prior incidents (or an explicit no-match), check current evidence, capture the
result, and attempt durable synchronization. History does not raise deterministic
confidence. Missing environments remain visibly unknown. Accuracy feedback is
separate from a confirmed incident disposition. Startup output includes the matching
fields, last verification date (or “never”), report references, historical outcome,
and first check.
Broad Elasticsearch checks search the configured native event-code field as well
as message/context fields. Supplier error codes are not assumed to be logger codes.
Recorded provider/event identity survives sync and suppresses repeated reports for
the same event in the shortlist. Legacy records without that identity retain their
existing report-based grouping.
Native Elasticsearch logger codes are stored separately from actual supplier
error codes. An unknown, inferred history item with the same specific log message
may supply unverified operation context across logger codes; generic wrapper
messages, different recorded statuses or actual errors, operation/workflow
conflicts and confirmed outcomes retain strict matching. Recurrence consolidation
keeps its existing identity guards. Cloud preserves the native source, event ID
and logger code when restoring this context on another profile.
Polling retains Elasticsearch's native `_index`/`_id` identity separately from
untrusted source fields; a content digest is used only when no document ID exists.
Set `HORUS_STARTUP_RECALL=0` to disable startup recall while keeping stored history.

The local dirty generation and frozen outbox survive process exit and a lost HTTP
response. Server revisions order updates independently of laptop clocks. Private
replicas remain editable on a second machine. Team promotions use the existing
read-only cache. Local memories are bound to the selected account/project on their
first sync; another account cannot export that bound history.

```sh
horus memory sync --dry-run
horus memory sync --json
horus memory sync --resolve MEMORY_ID --choice local
horus memory sync --resolve MEMORY_ID --choice cloud
horus memory sync --restore MEMORY_ID
horus ask INVESTIGATION_ID
```

`--yes` remains accepted for old scripts; recurring approval is unnecessary.
Conflicting corrections remain visible in `--json`, and rejected operations are
retained in Cloud history. A forgotten record requires explicit restoration.
Backfill scans saved investigations and resumes on subsequent passes; a short CLI
invocation may leave visible pending work. Raw vectors and unnamed payload fields
are excluded. Cloud report references resolve to actual saved reports on demand.
Imported report copies refresh on demand, so a report restored before its AI stage
finishes picks up the completed interpretation. The last saved copy remains usable
offline; locally authored reports are not overwritten by this refresh.
The `backfill` status counts eligible/indexed/pending/excluded saved reports separately
from the memory synchronization counts. Unreadable report payloads are isolated so
readable history can continue backfilling. Their IDs and a separate `backfill.failed`
count remain visible, and the state stays `Pending sync` until they are recovered.
Failed rows are never counted as excluded or overwritten automatically.
Completed report uploads are checkpointed with their authorized Cloud scope before
the memory operation is published. Interrupted passes resume the remaining report
references instead of repeating every upload in a large recurring incident family.

On a clean second machine: install the paired CLI, log into the same account, and link
the same Cloud project. Linking automatically starts bounded restoration; subsequent
commands/service passes continue pending work. The checkout path/local alias may differ.
Use `horus memory sync` to inspect or manually retry, and verify recall and `horus ask`
before enabling unattended work.

For an evidenced inference, use `horus memory add "Bounded finding" --outcome-file
/path/to/inferred-outcome.json`. This stores a private, derived incident pattern,
checks that its source investigation belongs to the selected project, and does not
write an accuracy label or verification timestamp. The file must say
`certainty: "inferred"` and include evidence references. The finding stays inferred
through sync and recall. To replace it, forget the old item and add the corrected
finding; existing memory links can record `supersedes`.

For an attested disposition, use `horus memory confirm INVESTIGATION_ID --outcome-file
/path/to/outcome.json`. The file uses the disposition schema: `disposition`
(`confirmed-incident`, `expected-behavior`, `duplicate-alert`, `monitoring-error`,
`unknown`), `certainty`, `sourceInvestigation`, `sourceRefs`, `applicability`,
`invalidatingConditions`, and `checks`; confirmed entries also require `attester`
and `verifiedAt`. A positive accuracy label never means the alert was harmless.

Unattended result notifications include bounded current evidence citations, matched
history labeled as context, the next check, and the Cloud report link. An uncertain
AI result stays uncertain even when the engine has a ranked hypothesis.

## Activate a local service

Use an absolute, stable installed CLI path, Node path, and Claude executable path.
Verify that the configured local user can invoke Opus 5.5 through Claude Code before
activation; executable discovery does not prove model access or provider access.

Create `~/.horus/service/settings.json` with mode `0600`. Example below uses pilot
caps you must choose from observed volume; the values are examples, not defaults.
`config` points at your existing `.horus/config.json`, or a native JS/TS config.
Multiple entries are selected projects, served in round-robin order by one executor.

```json
{
  "runtime": "/absolute/path/to/node",
  "entry": "/absolute/path/to/horus/apps/horus/dist/index.cjs",
  "claude": "/Users/your-user/.local/bin/claude",
  "intervalSeconds": 60,
  "deadlineSeconds": 300,
  "dailyInvestigations": 20,
  "dailyModelCalls": 30,
  "cloudWebUrl": "https://cloud.horus.sh",
  "environment": {
    "PATH": "/Users/your-user/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"
  },
  "projects": [
    {
      "root": "/absolute/path/to/maison-safqa",
      "config": "/absolute/path/to/maison-safqa/.horus/config.json",
      "project": "maison-safqa",
      "environment": "production",
      "source": "pagerduty",
      "enabled": true,
      "notifications": "off",
      "idempotentDestination": false
    }
  ]
}
```

Use `sentry` or `elasticsearch` for their existing authenticated polling connectors.
`auto` prefers configured Sentry. No other provider is advertised as active.
Choose one trigger per project/environment; Slack is a destination, not another
trigger for the same native PagerDuty event. Elasticsearch is a selectable fallback.
Order/workflow or correlation fields group related retry events; distinct order IDs
remain distinct jobs. Missing structured identity cannot prove cross-provider
correlation and must be corrected in provider routing before parallel ingestion.

The initial polling policy is the prior 24 hours. Execution is one job per project
per cycle (therefore below the ten-job immediate bootstrap cap); remaining work is
visible backlog. Cursors use two minutes of overlap. Sentry pages are durable and
known open issues are reconciled five at a time for resolution. Elasticsearch
subdivides dense windows; more than 1,000 events in the smallest window produces
an actionable gap instead of silently advancing. ES has no native resolve event;
a quiet hour starts a new episode. Provider retention can prevent recovery after a
long offline period; status reports the gap for verification.

```sh
horus service check --settings /absolute/path/to/settings.json
horus watch --settings /absolute/path/to/settings.json --once
horus service install --settings /absolute/path/to/settings.json
horus service status
horus service pause --path /absolute/path/to/maison-safqa --env production
horus service resume --path /absolute/path/to/maison-safqa --env production
horus service stop
horus service start
horus service remove
```

`watch` now uses the same durable settings/queue as launchd; its former source and
interval flags belong in the settings file. `install` validates executable access,
Claude login, Cloud authorization, and selected provider connectivity. It does not
prove that a live PagerDuty rule sends an event: send a controlled test through the
configured subscription before declaring monitoring active. `start` loads a stopped
profile; login reloads installed LaunchAgents. Stop/remove preserve queue and reports.
Pause/resume atomically updates the selected project's existing `enabled` setting.
The running service reloads settings each cycle. An active investigation finishes;
new detection/execution stops on the next cycle, and queued work and cursors remain.
These commands work while the worker owns PGlite because they only update settings.
Omit `--path` to select the current directory; supply `--env` when it has several
configured environments. Changes to authentication environment variables or runtime
paths still require restarting the installed service.

launchd explicitly receives HOME, PATH, selected Horus profile paths,
CLAUDE_CONFIG_DIR when configured, and the settings' environment entries. Connector
environment secrets must be supplied there or through existing Horus credential
storage; launchd does not load an interactive shell. Do not add an Anthropic API key
for the adapter. Settings and the LaunchAgent plist may contain selected environment
secrets: keep both private and outside Git.

Each incident invokes exactly:

```sh
claude -p --model claude-opus-5-5 --permission-mode bypassPermissions --output-format json
```

The redacted prompt goes through stdin. It contains the alert, current evidence and
citation IDs, startup recall, and stable report identity. No `--continue`, shell
interpolation, second investigation, Sonnet substitution, or direct Anthropic API
call is used. Existing read-only Horus commands can support targeted checks; an
uncited follow-up cannot be promoted to validated report evidence. The AI judgment
uses the existing report annotation; deterministic scoring remains authoritative.

The engine saves before Claude starts. AI, upload, notification, and Cloud completion
checkpoint separately. The validated Claude result is saved before report annotation;
recovery reuses its session/result instead of repeating inference. Three invalid/model failures produce a labeled engine-only
report. Deadlines/cancellation terminate subprocess groups and descendants, and retain
the deadline, shutdown or claim-loss reason in status instead of generic cancellation. A missing
or stale source index is reported; the service does not run indexing per incident.

## PagerDuty and the Cloud queue

Cloud endpoint setup requires workspace/project administrator access. Using the
existing authenticated API client or your API tooling:

1. `POST /v1/workspaces/WORKSPACE_ID/alert-sources` with `name`, `provider:
"pagerduty"`, `projectId`, `environment`, and native `serviceId`. Save the returned
   `postUrl`, ending in `/pagerduty`.
2. Create a PagerDuty **v3 webhook subscription** for that exact service and URL.
   Include triggered, acknowledged, resolved, escalated, reopened, and priority-update
   events supported by your subscription.
3. Set the subscription's actual signing secret with `PATCH
/v1/workspaces/WORKSPACE_ID/alert-sources/SOURCE_ID` and `{ "signingSecret": "...",
"enabled": true }`. The secret generated by Horus is not a PagerDuty secret.
4. Replay a signed test event and verify its project/environment, queue, report,
   and configured destination before enabling the project in service settings.

Verification follows [PagerDuty's native v3 signature contract](https://docs.pagerduty.com/developer/verifying-webhook-signatures).
Unknown event types are ignored; a wrong service or invalid signature is rejected.
The generic signed webhook remains compatible but is not a native provider adapter.
PagerDuty's v3 incident webhook omits alert custom details. Maison Safqa's verified
producer creates separate native incidents for initial EMODA dispatch errors,
workflow retries and exhaustion. Configure the source's write-only `apiToken` with
a **read-only PagerDuty REST key** and `apiRegion: "eu"` for the Meritt EU account
(`"us"` otherwise), using the existing create/PATCH source endpoint. The API reads
only the routed incident and its first trigger log entry on fixed regional hosts;
it refuses redirects, bounds responses and shares a ten-second deadline. Credentials
and raw trigger/stack payloads never enter the normalized queue or source reads.

Confirmed order number and supplier failure context group those native incidents
into one EMODA dispatch episode. Changing failure context, a new initial occurrence
or native reopening starts a separate episode. Retries/exhaustion without a new
initial event may join the matching order/failure episode within 24 hours; later
orphan retries start a new occurrence. Native child resolutions update that
child, and a later retry retains the same explicit Cloud episode and saved report.
Source REST failures expose `lastError` and reject acknowledgement so PagerDuty can
retry; successful transactional acceptance clears the error. Without a REST key, legacy native incident
identity remains available, but cross-incident order grouping is not verified.
Unrelated producer shapes retain native identity; never treat all EMODA alerts as
false positives. The mapper cannot split a native incident already combining orders.
Migration `0036_pagerduty_details` adds the write-only details credential and source
health fields to the existing source table.

The outbound CLI uses the existing investigation-request routes, extended with
90-second leases, 25-second heartbeats, claim tokens, worker identity, attempts, and
retry/terminal states. Routed claims require explicit authorized project/environment.
A stale token cannot heartbeat or complete. Cloud completion retries are idempotent.
`claimed` and `done` names remain compatible with older callers; the new states are
`retry_wait`, `terminal_failed`, and `cancelled`.

`GET /v1/workspaces/WORKSPACE_ID/alert-workers` and workspace settings show liveness.
No heartbeat for two minutes means offline; an expired claim is awaiting recovery,
not evidence of active execution. Five exhausted claims remain inspectable and
require explicit retry. Queue/report identity survives a replacement claim.
Source backoff retains its error and retry time while the worker continues Cloud
heartbeats. Three failed polls show a degraded worker; an exhausted daily budget
takes precedence. A changed account/project cannot heartbeat the previous route.

## Notifications, limits, and recovery

Set `notifications: "configured"` only after selecting the existing environment's
`notify.webhook`. Cloud report storage is automatic and alone is not an outbound
notice destination; use `notifications: "off"` for report-only operation.
Uncertain high-urgency reports are sent;
the service does not apply the foreground confidence threshold. Each message carries
a real uploaded report link, current uncertainty, and a next check.

For automatic retries, set `idempotentDestination: true` only when the receiving
endpoint honors the stable `Idempotency-Key`/`notificationKey`. A bare Slack incoming
webhook does not provide that contract: use an idempotent relay, or leave the flag
false. After an uncertain send without receiver deduplication, Horus retains the
failure and requires inspection instead of sending possible duplicates.

```sh
horus service retry --job JOB_ID
# Only after checking whether the destination already received the message:
horus service retry --job JOB_ID --delivery-checked
```

Acknowledged severity updates get a new delivery checkpoint; cycling back to a prior
severity still produces a distinct update. Uncertain retries retain their delivery
key and require destination deduplication or explicit delivery inspection.

Claude and its tools share the supervised worker's process group, so a hard-killed
worker cannot leave its model/tool descendants running outside supervisor cleanup.
If the controller dies, its IPC connection closes and the worker terminates its own
group. The replacement controller resumes the saved job/report checkpoint.

Notification retries never rerun inference. Daily caps are global across selected
projects and reset at UTC midnight. Exhaustion defers work visibly and attempts one
configured operational notice for that day. Terminal failures also retain their
stage, error, report, and an operational-notice checkpoint.

The active queue cap is 500 jobs per route; at capacity, source cursors stop advancing
and status reports backlog. Logs rotate at 1 MB with one previous file. Status and
logs live under `~/.horus/service/` (or the explicitly selected test/profile root).

PGlite requires one live process owner. Concurrent CLI access returns `HORUS_DB_BUSY`
after a bounded wait. Never delete a live owner's lock. A dead PID is recoverable;
malformed lock metadata or an interrupted cleanup fails closed and needs inspection
with all Horus processes stopped. PID age alone never grants database access.

## Verification and rollout

Run unit and end-to-end suites only in hosted CI, never on the local machine.
The existing Horus workflow checks the workspace and built CLI. Its hosted macOS
job runs `scripts/test-service-launchd.ts` with an isolated profile, disabled
notifications and no live provider/model calls: install, pause/resume, crash
restart, retained state, status, stop and removal.

Cloud's existing verify job migrates disposable PostgreSQL and runs the three
canonical paired contracts sequentially: `test-memory-integration.ts`,
`test-service-integration.ts` and `test-watcher-inputs.ts`. The companion Horus
revision is pinned explicitly. Trusted-header authentication is disabled.
The Cloud browser job uses a temporary Clerk test user, real JWT verification and
a disposable API/database; cleanup deletes only that run's tagged user.
Inspect its Playwright step because the browser workflow is non-blocking.

| PRD requirement | Existing verification | Remaining release evidence |
| --- | --- | --- |
| 01 M1 / A1–A3: startup recall and current evidence | Hosted chronological holdout: 12/12 recurring top-three matches, 3/3 unrelated no-matches, no false matches; earlier reports only | Small, operation-context sample; broader coverage improves confidence but is not a separate PRD gate |
| 01 M2: dispositions vs accuracy | Three real EMODA annotations imported through memory add and read back from production Cloud as private/inferred, with evidence, checks and report links; the unchanged Mac worker automatically restored them (153 memories, zero pending/failures) | A future confirmed outcome still requires actual attestation or an authoritative source; no cause confirmation was invented |
| 01 M3–M4 / A4–A10: sync and restoration | Authenticated paired memory contract: two profiles, lost replies, revisions, conflicts, deletion/restoration and identity isolation | Real second-host initial restore and large report read verified; fresh interactive login/live corrections not exercised |
| 01 M5 / A11: visible failure | Local persistence/sync failure checks and bounded refresh | Production latency percentiles |
| 01 M6: attributed AI context | Worker prompt/citation checks; historical real local Opus sessions | Jev stays disabled without measured improvement |
| 02 S1 / A1–A2: lifecycle | Hosted macOS launchd check; durable queue/heartbeat contracts | Physical sleep/wake and logout/login |
| 02 S2–S3 / A3–A9: cursors, grouping and claims | PagerDuty, Sentry and Elasticsearch contracts; two claimants, stale leases, partial checkpoints and database ownership | Actual production alert subscriptions and retention |
| 02 S4 / A10, A13–A15: investigate and deliver | Checkpointed engine/AI/report/delivery contracts; invalid output, cancellation and descendants; historical local Opus authentication | Live configured destination policy; CI uses controlled Claude output |
| 02 S5–S6 / A11–A12: scope, budgets and health | Native provider replay, queue limits, deadline/budget checks, offline/expired-claim browser check; three actual Claude estimates total USD 4.6917826; seven-day native PagerDuty history: peak ten triggers/day | Fresh delivery rates and healthy-path latency; temporary caps remain reviewable as live volume changes |

The selected Maison PagerDuty service's September 26–October 2 UTC history contains
ten triggers, eleven acknowledgements and ten resolutions, all on September 27.
All 204 retained incident metadata records were scanned for changes; no older
incident changed within that week. The ten changed incidents contain 107 log
entries, including notification/assignment records that do not each start an
investigation. The temporary 30-investigation cap leaves three times the observed
peak of ten native starts; 45 model calls allows all three bounded attempts for
that peak plus 50% headroom. Related retries may group into fewer episodes.
These remain adjustable pilot caps, not a forecast or proof of future volume.
Historical provider reads do not certify fresh webhook delivery or start latency.

The read-only Maison Safqa Elasticsearch pilot completed its September 28–October 1
72-hour elapsed window using frozen runtime `08db520`, isolated local Cloud storage,
notifications off and unchanged budgets. It completed 60 additional jobs, ending with
90 distinct report IDs, no remaining jobs and no pending memory sync. Of the 90 reports,
87 retained validated Opus interpretations and three used labeled engine-only fallback.
An actual shutdown/reboot caused a ten-hour observation gap; LaunchAgents recovered the
same history after login. This is elapsed-window and reboot-recovery evidence, rather
than 72 hours of continuous online availability. The subsequent cancellation-diagnostic
fix is outside this recorded window. Physical sleep/wake and fresh native delivery
remain unverified. The later physical second-host restore passed, and the frozen
15-case chronological pilot holdout meets the proposed numerical targets. The
labels are source-reviewed operation relevance, not human-attested causes; the
PRD does not require a human reviewer or prescribe a minimum sample size.
No local automated test or fault-injection scripts ran during the window.

Before release, verify production rules/subscriptions and destination policies,
private report storage and migrations, then complete the labeled recall holdout
and 72-hour selected-project soak including physical lifecycle and network loss.
The selected Maison Safqa private Mac pilot is active against production Cloud with notifications off; public automator release remains gated while these checks are open.
Azure/AWS/Grafana triggers, managed execution, Linux packaging and PRD 03 remain
later scope. Cloud ingestion does not imply always-on investigation execution.

For the chronological recall gate, run the existing history replay only in hosted CI:

```sh
HORUS_RECALL_HISTORY=/private/readable-history.json \
HORUS_RECALL_LABELS=/private/recall-review.json \
pnpm exec tsx scripts/test-recall-history.ts
```

The review contains `reviewer`, `version`, and `cases`. Each case names an exported
report `id`, an exhaustive `relevantReportIds` list (empty for an unrelated case),
a `rationale`, and `sourceRefs`. Review relevance independently of retrieval output
and headline-accuracy labels. Relevant reports must precede the query report;
future/self references and non-earlier recalled records are rejected. The result
reports both sample sizes, rates, misses and false matches, and exits unsuccessfully
unless both strata exist and meet the proposed 90%/95% targets. Unlabeled replay
remains diagnostic only. Pilot outcome annotations are added after scoring.

The push CI job also runs this replay when the repository secret
`HORUS_RECALL_REVIEW_BUNDLE` contains base64-encoded gzip JSON with `history` and
`review` objects in those formats. Use a minimal report projection, never raw
customer logs or connector credentials. CI deletes its temporary files on exit;
pull-request runs do not decode the private dataset. Missing data leaves the
quality gate unverified. Small or operation-only samples remain exploratory,
even when their measured rates exceed the targets.


## Live worker activity in Cloud

Open **Agent Runs** for live workers, unfinished queue requests and searchable run history. The same worker panel is available in workspace **Settings**. The Mac makes
outbound authenticated REST calls to the existing queue and worker endpoints;
Cloud never opens an inbound connection into the Mac. Claim renewal remains
25 seconds. While investigating, best-effort activity snapshots publish every
two seconds, independent of claim renewal. They retain the latest 100 stage and
tool-category events on the existing worker row.

The browser receives Server-Sent Events through an authenticated same-origin
route. Cloud samples its durable worker rows every three seconds, checks workspace
membership each time, and closes streams after 45 seconds so reconnection obtains
a fresh credential. Hidden tabs close their stream; reconnecting tabs recover the
current snapshot. Two minutes without a heartbeat means offline. This is a live
snapshot feed, not a complete audit log or a guarantee of subsecond delivery.

The required local invocation still uses `claude -p --model claude-opus-5-5
--permission-mode bypassPermissions --output-format json`, stdin for the incident,
and the configured user’s login. Session-specific `--session-id` and `--settings`
add documented Claude command hooks (SessionStart, PreToolUse, PostToolUse,
PostToolUseFailure, Stop). Only finite event/tool categories leave the Mac; hook
arguments, output, file paths, credentials and private reasoning are discarded.
Session identity is checked against the validated final JSON result. Hook metadata
files are private, bounded and removed after interpretation. Failed activity
transport cannot fail or retry an investigation. Final validated findings remain
in the saved report.

Apply Cloud migration `0037_worker_activity` and deploy both the API and web app
before upgrading the private worker runtime. Hosted CI covers the activity schema,
workspace isolation/revocation, SSE updates, UI reconnection and the paired worker
contract. No local automated test, integration, replay or lifecycle scripts should
be run.

New background runs enrich the same run record created by durable memory sync with the validated model and measured execution timing. Missing/reversed legacy timing stays “Not recorded”; captured output is distinct from the saved investigation’s evidence and findings.

Each new background run also saves its latest 100 stage/tool events and the redacted validated final answer in the existing AgentRun logs (`application/vnd.horus.activity+json`, version 1). Run details render an ordered UTC timeline. The completion checkpoint retries logs delivery without repeating inference; a final best-effort update includes the done event. This is bounded history, not a full transcript. Older sessions can be recovered from actual Claude tool timestamps with source `claude-session`; missing worker stages remain explicitly unrecorded. Plain-text logs remain readable. No raw prompts, tool content or private reasoning are uploaded.


### Real second-host restoration

A clean profile on the existing interserver machine, running the same private CLI
build with Node 24.11.0, restored all 150 acknowledged private Maison memories
through normal Cloud linking. Its local alias differed from the Mac checkout;
no local database or history export was copied. A saved large report was fetched
on demand by `horus ask` and remained usable by `horus packet`. Sync inspection
reported zero pending operations, failures or conflicts. The temporary owner
credential was removed after use. This covers initial restoration on a physical
second host; fresh interactive login and live competing corrections were not
exercised. Linux service packaging remains deferred, and the Mac soak is unchanged.
