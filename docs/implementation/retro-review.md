# Retrospective changes: review verdict

Intent: implement the seven approved environment improvements through existing
commands, status files, CI and deployment paths. Hosted CI owns automated suites.
Public service acceptance remains separate from build success.

Reviewers: GPT-6 Astra, GPT-6.1 Sol and local Claude Opus 5.5. The configured Claude
Agent-tool aliases are unavailable through Codex's subagent tool; valid available
models and the authenticated local Claude CLI supplied the review.

## Act on

- Both GPT reviewers and Opus found stale CI/source evidence or incomplete source
  comparison. Receipts now require both recorded CI revisions; publication compares
  dependency/build inputs and the deployed Cloud compatibility identity.
- Astra and Opus found private Cloud reads cannot use Horus's repository token.
  Pairing now uses the existing public version endpoint without additional credentials.
- Astra found reusable-workflow concurrency could cancel its caller. The callee's
  duplicate concurrency setting was removed.
- Astra found the startup snapshot race. Hosted lifecycle checks wait for the full
  project snapshot rather than the early diagnostics file.
- Sol found unbounded job history could erase diagnostics at the snapshot size cap.
  Status now projects the latest 20 job summaries; database history is retained.
- Opus found observer failures shared CI-failure exit status and existing releases
  needed safe recovery. Observer errors now exit 2. The existing immutable-tag
  recovery flow remains; service tags require acceptance on repair as well as first
  publication, while legacy connector tags remain repairable. Fatal exits no longer
  carry a misleading signal.

## Consider / noted

- Dry-run publication still checks service acceptance intentionally: it is not a
  substitute for the separate packaging build or CI. No publication gate is waived.
- Recorded restarts include intentional reloads. The UI describes recorded restarts,
  not crashes, and retains the prior reason rather than inferring instability.

## Dismissed

- Missing migration: 0041_worker_supervisor.sql is staged. This repository's recent
  manual migrations use SQL plus journal entries; no new snapshot convention is imposed.
- Plain-text JSON fixture: deliberate coverage for the exact historical captured-output
  regression. Existing parser units cover the canonical activity media type.
- Future unknown supervisor fields: strict finite metadata is the current intentional
  boundary. Cloud deploys before the new CLI heartbeat fields are activated.

Agreement was strongest around release freshness and cross-repository authentication.
Only the concrete correctness findings were applied; existing architectures were retained.

The first public-main CI run exposed cold CLI test contention; package concurrency
is now bounded to two. Full failure logs are saved once by the observer, with a
focused excerpt, so early failures are not lost in later job output.
