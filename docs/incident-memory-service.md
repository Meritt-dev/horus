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
report. Deadlines/cancellation terminate subprocess groups and descendants. A missing
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

Reproduce isolated
contracts with an explicitly disposable, migrated local Cloud database whose name
ends `_test`:

```sh
HORUS_CLOUD_TEST_DATABASE_URL=postgres://.../horus_prd_test pnpm exec tsx scripts/test-memory-integration.ts
HORUS_CLOUD_TEST_DATABASE_URL=postgres://.../horus_prd_test pnpm exec tsx scripts/test-service-integration.ts
HORUS_CLOUD_TEST_DATABASE_URL=postgres://.../horus_prd_test pnpm exec tsx scripts/test-watcher-inputs.ts
pnpm exec tsx scripts/test-service-launchd.ts
```

Tests create isolated Horus profiles and localhost destinations. Do not run Cloud
suites that truncate the same database concurrently. The native launchd smoke test
creates/removes a named test profile, verifies pause/resume without a process restart,
and uses an unconfigured provider so no live source is contacted.

For the real local-user authentication path, `scripts/test-live-project.ts` supports
`HORUS_LIVE_LAUNCHD=1`, an absolute `HORUS_LIVE_CONFIG`, `HORUS_CLAUDE_BIN`,
and a migrated `HORUS_CLOUD_TEST_DATABASE_URL` on localhost. Set `HORUS_LIVE_GREP`
to a known real Elasticsearch error and `HORUS_LIVE_ENV` to the selected environment. It runs one captured real incident through launchd,
authenticated Opus, a disposable local Cloud server, and clean-profile restoration;
notifications are disabled and the named LaunchAgent is removed afterward.

Before release: confirm live provider rules/subscriptions and destination policies,
run captured event replays, obtain the PRD 01 EMODA human attestations/holdout, then
perform a 72-hour selected-project soak including restart, process kill, sleep/wake,
network loss, duplicate delivery, budget exhaustion, and manual CLI contention.
Measure startup recall, sync latency, queue delay, failures, and duplicates. Short
local tests are not a substitute for that gate. Do not enable all production projects
or claim always-on coverage while the only executor is a sleeping laptop.

For an Elasticsearch fallback pilot, measure the preceding seven complete UTC days
before selecting daily caps:

```sh
HORUS_LIVE_CONFIG=/absolute/project/.horus/config.json \
HORUS_LIVE_ENV=production \
pnpm exec tsx scripts/measure-watcher-volume.ts > /private/path/watcher-volume.json
```

This opt-in script reads bounded error-log windows using the configured connector
and replays them through the existing episode store in a disposable local database.
It prints daily event/episode counts and a peak, verifies duplicate replay, then
removes the temporary database. It performs no investigations, model calls,
notifications or Cloud writes. Set `HORUS_VOLUME_END` to an ISO timestamp to repeat
the same historical window. Query/event caps or incomplete Elasticsearch results
fail the measurement rather than presenting a partial count as complete.

Use the observed peak to choose a provisional investigation cap; choose model-call
headroom separately for retries and validate it during the soak. Indexed ES volume
does not establish PagerDuty volume, model cost, upstream retention or 72-hour
service reliability. The watcher also rejects timed-out, early-terminated or
failed-shard responses without advancing its cursor, so a later poll can retry.

For a private exported history, replay without opening the user's database:

```sh
HORUS_RECALL_HISTORY=/absolute/path/private-history.json \
HORUS_RECALL_PILOT=/absolute/path/reviewed-pilot-dispositions.json \
pnpm exec tsx scripts/test-recall-history.ts
```

The export must have a `reports` array containing saved investigation rows. The
optional pilot file requires its source reports. The script uses and removes a fresh
PGlite profile; it does not install annotations into live memory. Counts and local
recall timings are diagnostic, not the PRD's held-out accuracy or end-to-end latency
gates. Preserve a backup and verify source-history integrity before attempting
backfill; corrupt or unreadable reports require recovery rather than silent exclusion.

To include full report upload, clean-profile restoration and latency measurements,
run the existing memory integration script with the same `HORUS_RECALL_HISTORY`.
Large real reports require local object storage as well as the disposable Postgres
instance. The local check used LocalStack 4.14.0 S3, a private test bucket, dummy
credentials, and these process-scoped settings:

```sh
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
STORAGE_PROVIDER=s3 STORAGE_BUCKET=horus-prd-memory-test \
STORAGE_REGION=us-east-1 STORAGE_ENDPOINT=http://127.0.0.1:55456 \
STORAGE_FORCE_PATH_STYLE=true \
HORUS_CLOUD_TEST_DATABASE_URL=postgres://horus:horus_test@localhost:55439/horus_prd_test \
HORUS_RECALL_HISTORY=/absolute/path/private-history.json \
pnpm exec tsx scripts/test-memory-integration.ts
```

Provision that bucket on the isolated local endpoint first. The script rejects a
remote storage endpoint for historical replay, deletes only its own Cloud tenant,
and removes its temporary profiles. Stop/remove the owned test storage container
when finished to discard its private report objects. Never substitute production
credentials or a production database for this test.
