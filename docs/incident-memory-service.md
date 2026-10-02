# Incident memory and the macOS investigation service

This release extends the engine memory store, shared investigation runner, watcher,
Cloud memory service, and Cloud alert queue. Cloud accepts work; your Mac executes
it. PRD 03, Azure/AWS/Grafana trigger adapters, Linux packaging, managed execution,
and Jev ranking are outside this change.

## Deploy the paired versions

Deploy Horus Cloud with migrations `0034_memory_revisions` and `0035_alert_leases`
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
from the memory synchronization counts.

On a clean second machine: install the paired CLI, log into the same account, and link
the same Cloud project. Linking automatically starts bounded restoration; subsequent
commands/service passes continue pending work. The checkout path/local alias may differ.
Use `horus memory sync` to inspect or manually retry, and verify recall and `horus ask`
before enabling unattended work.

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
retry; successful reads clear the error. Without a REST key, legacy native incident
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
| 01 M1 / A1–A3: startup recall and current evidence | Startup recall/engine checks; chronological historical replay before the CI-only instruction | Human-attested relevance and unrelated no-match holdout |
| 01 M2: dispositions vs accuracy | Outcome schema, provenance and memory contracts | Confirmed EMODA outcomes, rather than inferred labels |
| 01 M3–M4 / A4–A10: sync and restoration | Authenticated paired memory contract: two profiles, lost replies, revisions, conflicts, deletion/restoration and identity isolation | Physical second machine and production storage/migrations |
| 01 M5 / A11: visible failure | Local persistence/sync failure checks and bounded refresh | Production latency percentiles |
| 01 M6: attributed AI context | Worker prompt/citation checks; historical real local Opus sessions | Jev stays disabled without measured improvement |
| 02 S1 / A1–A2: lifecycle | Hosted macOS launchd check; durable queue/heartbeat contracts | Physical sleep/wake and logout/login |
| 02 S2–S3 / A3–A9: cursors, grouping and claims | PagerDuty, Sentry and Elasticsearch contracts; two claimants, stale leases, partial checkpoints and database ownership | Actual production alert subscriptions and retention |
| 02 S4 / A10, A13–A15: investigate and deliver | Checkpointed engine/AI/report/delivery contracts; invalid output, cancellation and descendants; historical local Opus authentication | Live configured destination policy; CI uses controlled Claude output |
| 02 S5–S6 / A11–A12: scope, budgets and health | Native provider replay, queue limits, deadline/budget checks, offline/expired-claim browser check | Production rates, healthy-path latency and week-long cost calibration |

The read-only Maison Safqa Elasticsearch pilot completed its September 28–October 1
72-hour elapsed window using frozen runtime `08db520`, isolated local Cloud storage,
notifications off and unchanged budgets. It completed 60 additional jobs, ending with
90 distinct report IDs, no remaining jobs and no pending memory sync. Of the 90 reports,
87 retained validated Opus interpretations and three used labeled engine-only fallback.
An actual shutdown/reboot caused a ten-hour observation gap; LaunchAgents recovered the
same history after login. This is elapsed-window and reboot-recovery evidence, rather
than 72 hours of continuous online availability. The subsequent cancellation-diagnostic
fix is outside this recorded window. Physical sleep/wake, second-machine restoration,
production subscriptions/delivery and human-attested recall quality remain unverified.
No local automated test or fault-injection scripts ran during the window.

Before release, verify production rules/subscriptions and destination policies,
private report storage and migrations, then complete the labeled recall holdout
and 72-hour selected-project soak including physical lifecycle and network loss.
No production automator activation is declared while these gates remain open.
Azure/AWS/Grafana triggers, managed execution, Linux packaging and PRD 03 remain
later scope. Cloud ingestion does not imply always-on investigation execution.
