# Changelog

All notable changes to the Horus CLI (`@merittdev/horus`) and its paired horus-source backend.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.21.5] — 2026-07-04

- **Implementations win over their `.d.ts` type declarations.** When a symbol exists both as real code and as a `.d.ts` re-declaration, `explain`/`search`/`blast-radius` now land on the implementation instead of the declaration stub — dayjs `Dayjs` resolves to the `class` in `src/index.js` (not a plugin `.d.ts`), commander `Option` to `lib/option.js` (not `typings/index.d.ts`). A `.d.ts` only wins when it is the sole match (a genuinely type-only export). Takes effect immediately — no re-index needed.

## [0.21.4] — 2026-07-04

Resolver: a library's real API is found even when its export has no name. (Batch B2.)

- **Anonymous & default exports now resolve to the implementation, not a test file.** When a package's public API is written without a named symbol — `module.exports = function` (jsonwebtoken's `sign`, winston's `createLogger`), `module.exports = class Application` (koa), `module.exports = X.extend({})` (joi), a cast/`satisfies`-wrapped const arrow (`export const createApp = (…) => …` in Vue, `export const createStore = (…) as T` in zustand), or a prototype method (`BaseComponent.prototype.render` in preact) — Horus now synthesizes a resolvable named symbol at index time. `explain`/`search`/`blast-radius` land on the real code (e.g. `sign.js`) instead of a same-named test helper that used to win by default, and cross-command answers agree (joi's `explain object` and `blast-radius object` now resolve to the same symbol). Re-exports under a different name (`export { X as Y }`) record an alias edge so a lookup on the public name redirects to the implementation. *These light up after your next `horus init` (or `--reindex`).*

Init durability — large monorepos onboard. (Batch B1 of the dogfood campaign.)

- **`horus init` no longer times out on large repos.** It used to block on the full embedding pass, so big monorepos hit the 900s analyze cap and left nothing usable — the campaign's #1 finding (medusa, vendure, nx). Init now returns as soon as the **structural index** is built (symbols + relationships), and embeddings warm in the background. Proven: **medusa (22,966 files) onboards in 40s** and **vendure in ~22s** — both previously timed out at 900s with no config written. `search`, `explain`, `blast-radius`, and `queues` all work immediately (semantic ranking sharpens once embeddings finish, which `init` now tells you: *"index ready (semantic search warming up)"*).
- **Resumable-friendly + honest progress.** The analyze timeout is now adaptive to repo size (and overridable via `HORUS_ANALYZE_TIMEOUT_MS`), and long indexing runs stream phase/files/elapsed liveness instead of looking hung. A structural-complete index with embeddings still warming is no longer mistaken for a broken index and needlessly re-analyzed.
- **No more false "dead code" from same-file calls.** A cross-language call-blocklist (meant for things like Python's `str.format`) was dropping real same-file/imported calls in other languages, so a live function like prettier's `format` reported `isDead: true` with zero callers — a verdict you could act on by deleting working code. The blocklist now never drops a call that resolves to a same-file or imported definition.

## [0.21.2] — 2026-07-04

The 12-round dogfood campaign's fix batch (~48 OSS repos + real projects), plus a simpler local story: **zero infrastructure**.

- **Local persistence is embedded — Docker and Postgres are gone.** The local database is pglite at `~/.horus` (nothing to install, nothing running). The `docker-compose.yml`, the `DATABASE_URL` runtime tier, and every "Postgres reachable" check are removed; a `database` block in config now just warns. Migrating off an old local Postgres is one command: `horus db import` (defaults to `$DATABASE_URL`) copies your investigations, evidence, findings, hypotheses, memory, and scores into the embedded store. Teams that want a shared database use Horus Cloud — that's what it's for.
- **Single-file installs stop crashing on `blast-radius`/`queues`.** The standalone binary shipped without the embedded database's runtime assets and both commands hard-crashed (`HORUS_DB_UNAVAILABLE`). They now degrade gracefully (a one-line note, no crash), the GitHub release publishes the assets, and `install.sh` places them next to the binary.
- **Machine-JSON contract hardened.** A `--json` failure (no config, host down, bad query) now always prints one parseable JSON error object on stdout — no more empty stdout or raw stack traces (`search`/`explain` were the worst offenders). `search --json` returns an object (`{results: […]}`) instead of a bare array; `explain --json` marks capped `alternatives` with `truncatedCount`; `packet` carries repo identity (name/branch/commit).
- **No more fake queues from type declarations.** Enum members in `.d.ts`/`.interface.ts` files (kafkajs/NestJS `GZIP`→`Snappy` from Kafka compression enums) can no longer register as queues, async boundaries, or blast-radius upstreams — types can't produce messages.
- **External-system detection requires real evidence.** Word-bounded matching (no more `stripe` inside `stripEndSlash`, `redis` inside `Redistribution`), comment/JSDoc lines skipped (no integrations minted from `{@link}` URLs or license headers), `.yarn/`/`generated/` excluded, and a repo's own language-support plugins (prettier's GraphQL formatter) no longer count as integrations.
- **Resolver: product code now beats test namesakes everywhere.** Product-vs-test is a hard tier on the qualified path too — an inherited product method outranks a same-named test-fixture method (undici `Pool.dispatch`), 16 fixture namesakes can't outvote one product class (oclif `Command`), and `.tst.*` files are recognized as tests (pino).
- **Failed init no longer dirties your repo.** `.horus/` is excluded via `.git/info/exclude` *before* analysis starts, so even a timed-out first index leaves `git status` clean.
- **Honest change attribution.** Chore/typo/formatting commits can't anchor a "deployment regression" cause, and commit attribution intersects the seed symbol's actual line range (`git log -L`) — a commit elsewhere in the same 4000-line file no longer reads as "a recent change to retry logic". Falls back to explicit "touching <file>" wording when line-level attribution isn't possible.

## [0.21.1] — 2026-07-03

Dogfood-driven fixes (wide TS/JS cycle on 0.21.0); all validated live, no behavior changes to real projects.

- **`horus init` no longer dirties your repo.** It ignored `.horus/` by writing to the tracked `.gitignore`, which left the working tree dirty and made Horus's own `what-changed` / dirty-worktree detection report its setup edit as evidence. It now writes to the repo-local `.git/info/exclude` (never a tracked file; follows a `.git` *file* for worktrees/submodules). After init, `git status` is clean.
- **Resolver stops landing on non-product code.** The resolver's product-over-tests filter had drifted from the shared path classifier and missed `bench/`, `benchmark/`, `perf/`, docs-site trees (`www/`, `site/`), and jscodeshift `__testfixtures__/`. Qualified lookups like `ZodObject.parse` now resolve to the real method instead of a `packages/bench/` file.
- **`horus queues` stops inventing queues from constants.** Enum/constant string literals were extracted as queues — bullmq's OpenTelemetry attributes became 35 fake queues with property accessors as "workers". Dotted-attribute names (`bullmq.job.id`), SCREAMING_SNAKE enum members, and same-file enum self-matches are now rejected; real queues (which have a named worker) are unaffected.
- **`horus architecture` external systems stop matching data/docs.** Word-list & dataset files, lockfiles, config, and docs-site content no longer count as integrations (e.g. drizzle's "kafka/django/clerk/stripe" came from seed name datasets). Detection is now product-source-only.
- **Honest change windows.** An investigation's auto change-window is anchored to the repo's last commit; on a dormant repo the label now names that date — *"the 14 days before the last commit (2023-05-10)"* — instead of "the last 14 days", so an old commit no longer reads as recent.
- **Loud on incomplete indexing.** If source analysis times out mid-embedding (symbols present, 0 vectors), `horus init` now fails with a resume hint instead of exiting 0 and leaving every later command to fail with "no source-intelligence connector configured".

## [0.21.0] — 2026-07-03

- **Config/cwd is the only project identity.** `--name` and `--project` targeting are gone from every command. The repo you run in — its `.horus/config.json` — IS the project; `-c, --config <path>` (or `cd`) targets a different repo, and `--repo <name>` selects a repository *within* the loaded config for monorepos/multi-project setups. The outside-a-repo error is now a single actionable line: *"No Horus config found. Run from a configured repo or pass --config <path>."* Domain flags keep their own spellings: `connect --sentry-project` (the Sentry project slug), and `horus cloud link <org/workspace/project>` (positional, no flag).
- **One canonical symbol resolver.** `search`, `explain`, `investigate`, and `blast-radius` now resolve the same query to the same symbol. Qualified lookups (`Reply.hijack`, `reply.hijack`, `app.use`, `Class.method`, `path/to/file:symbol`) prefer the real method over a fuzzy bare-name or a test-file match; product code outranks tests/examples by default (`--include-tests` / `--full` to include them); and when several exact matches genuinely tie, the pick stays deterministic and the alternatives are disclosed (in `--json` too) instead of silently guessing.
- **Agent-ready machine JSON.** `--json` added to `status`, `investigations`, and `scores`. `investigate`, `changes`, `timeline`, and `what-changed` now emit **compact JSON by default** — bounded top commits/files, counts, and `truncated`/`truncatedCount` metadata — with `--full` for the complete raw structure (a `timeline --json` that was ~2.6 MB is now ~18 KB). `--json` stdout is always one parseable document, even on failure; human text never leaks into it.
- **Reports follow the config — no nagging.** With no runtime connectors configured, investigations no longer say "source-only" or pitch `horus connect`; they state the evidence basis and route to useful follow-ups (`what-changed`, `owner`, `explain`). A connector that is configured but unavailable this run (missing secret / unset URL env) is now named as *"configured but unavailable"* and routed to `horus doctor`, distinct from "not configured".
- **Git truth in change reports.** `timeline` and `what-changed` surface working-tree state (staged/unstaged/untracked, insertions/deletions) — a dirty worktree is a real change source, so a 0-commit window over uncommitted work now says so instead of "0 commits". `changes HEAD HEAD` short-circuits to empty, derived/synthetic graph nodes are filtered out, and git truth (files by status, ±lines, runtime/test/docs/config buckets) is reported before the source-index structural impact.
- **Weak-evidence reports stop contradicting themselves.** A broad, diffuse recent change no longer reads as a "supported" deployment regression in one section while the summary says "no specific cause"; the broad-change and vague-performance signals now propagate consistently into suspected causes, hypotheses, and cause chains. The timeline gains bounded per-commit events, and a stale source index routes `horus init` as a real next step.
- **Queue topology truth.** `horus queues` and `horus architecture` now share one hygiene pass at the stitcher/read boundary, so test-fixture, placeholder, and generic queue names (`<name>`, `name`, `SEED_PRODUCTS`, `emails`, multiline code fragments) never appear — real production queues survive. `queues --live` guidance only shows when a queues-role Redis connector is actually configured.
- **Friendlier connector + cloud setup.** `horus connect sentry` now lists your organizations and projects and lets you **pick from a list** (like the Axiom dataset picker) instead of typing slugs — with graceful fallback to manual entry, and the live credential probe still blocks saving a connector whose key doesn't authenticate. `horus cloud link` and `horus context use` likewise let you pick from your accessible cloud projects rather than typing the `org/workspace/project` triple. `horus init --reindex` forces a full source re-analysis (stop host, wipe `.horus/source`, rebuild) to purge stale graph edges after a backend update.

## [0.20.0] — 2026-07-03

- **One codebase, one bundle.** The source-intelligence backend now lives only in this repo (`packages/source-py` — the standalone horus-source repo is archived) and ships **inside the horus bundle**: a Python wheel built at release time and included in the npm package, the Homebrew archives, and the GitHub release. Nothing is published to PyPI anymore. `horus init` installs the backend from the bundled wheel automatically, `horus update` keeps it in lockstep, and the backend version IS the horus version — the paired-version dance is gone. (Python 3.11+ with uv remains the only backend prerequisite; the wheel's third-party dependencies still resolve from PyPI as a normal package install.)
- **One onboarding command.** `horus setup`, `horus init`, and `horus index` are now a single `horus init`: it checks prerequisites (backend + Postgres, advisory), writes and registers `.horus/config.json`, starts the source-intelligence host, indexes the repo, and stitches queue boundaries. Getting started is now `horus init` → `horus connect <type>` → `horus investigate "<hint>"`. Re-running `horus init` is idempotent (reuses the healthy host, refreshes the index); `--changed --fast` keeps the pre-push knowledge refresh; `--source <url>` records an external host and skips the local spawn. The old `setup`/`index` names (and `generate-config`) are fully removed — they fail as unknown commands, including their `--help` forms.
- **Connector trust hardening.** One shared HTTP transport for Elasticsearch/Grafana/Sentry/Axiom (timeouts everywhere — ES and Grafana previously had none; bounded retry with backoff on 429/5xx/network errors). Secrets are now redacted from every connector error message, health detail, and evidence payload (connection-string credentials, upstream response bodies, queue failed-reasons). Connector failures are honest: a down Sentry/Axiom/Shopify/MongoDB/Postgres/Redis now surfaces as an explicit evidence gap in the report ("collection failed (auth failure)") with a confidence impact, instead of silently reading as "no evidence found".

## [0.19.1] — 2026-07-01 · horus-source 2.1.0

- `horus connect shopify` now asks **which auth model** you're using up front — *static Admin API token* or *Client-Credentials app* — and prompts only the fields that mode needs, instead of ambiguous optional fields. The credential is required: the wizard re-prompts on a blank secret and, as a general safety net, `horus connect` now **refuses to save any connector that's still missing a required field** (previously a Shopify connector could save with no token and wrongly report success). Secrets stay masked on input and in the summary, and encrypted at rest — unchanged.

## [0.19.0] — 2026-07-01 · horus-source 2.1.0

- New **Shopify Admin connector** — bring your store's data into investigations. `horus connect shopify` wires up a store with either a static Admin API access token or a Client-Credentials app (access id + secret, which Horus exchanges for a short-lived token automatically and refreshes); the store name is just the subdomain (`.myshopify.com` is added for you), and the secret is encrypted at rest like every other connector. The connector embeds **no queries**: you supply the Admin GraphQL query at investigation time (`horus investigate --shopify-query @orders.graphql`, a raw string, or `-` for stdin; repeatable, with `--shopify-variables`), or declare default `queries` in config for `horus watch`. The engine binds the investigation window into `$from`/`$to` when the query declares them and folds each result into the report as application-`state` evidence alongside logs, metrics, and code — surfaced in `horus status`, `horus doctor`, and `horus readiness`. Read-only.

## [0.18.0] — 2026-06-30 · horus-source 2.1.0

- **Go, Java, and Rust support.** Horus now indexes Go, Java, and Rust repositories (paired horus-source 2.1.0): functions/methods, structs/classes/records/enums, interfaces/traits, imports, call graphs, and heritage (Java `extends`/`implements`, Rust `impl Trait for Type`); Spring annotations feed entrypoint detection. Verified end-to-end on real OSS repos. (HOR-459, HOR-460, HOR-461)
- **Sharper causes when nothing is linked to the seed.** When no runtime error is structurally tied to the implicated code, investigations now surface a symptom-matching runtime signal — a warn-level event whose code names the symptom (e.g. `SALE_028` "Sale with link not found" for "sale links broken") — as a hedged cause ranked above a speculative deployment guess, instead of defaulting to "a recent commit may have caused this". Precision-gated so a loud unrelated warning can't false-match. On a live tenant's eval set this lifted headline accuracy from ~28% to ~57% with no false fires. (HOR-453)
- Internal: the horus-source backend is now also vendored into the monorepo (`packages/source-py`) with its own CI, the first step toward a single-repo/single-release setup. No user-facing change. (HOR-450)

## [0.17.1] — 2026-06-30 · horus-source 2.0.2

- New `horus notify` command to configure the watch outbound sink (0.17.0) without hand-editing config: `horus notify set --url <webhook> [--secret <s>] [--min-confidence 0.6] [--cloud]`, plus `show`, `test` (sends a sample dispatch to verify the webhook), and `remove`. The webhook signing secret is stored encrypted in `.horus/secrets.local.json` (never plaintext in config), consistent with connector-secret encryption. (HOR-454)

## [0.17.0] — 2026-06-30 · horus-source 2.0.2

- `horus watch` can now NOTIFY you. When it auto-investigates a new incident and the result clears a confidence threshold, it dispatches the one-line cause to a configured outbound sink — a generic webhook (Slack-compatible JSON, HMAC-signed with `X-Horus-Signature` when you set a secret) and/or a Horus Cloud push. Configure per environment: `environments[].notify: { minConfidence, webhook: { url, secret }, cloud }`. Best-effort and resilient — a failed dispatch is logged and the watch loop keeps running. No daemon; `watch` stays a poller. (HOR-454)

## [0.16.1] — 2026-06-30 · horus-source 2.0.2

- A broad, sweeping commit (e.g. a large integration touching dozens of files) that merely *included* the implicated file is no longer presented as the confident root cause of an unrelated symptom. When the most-focused recent change touching that file is still broad and nothing else corroborates it, the investigation now says "No specific cause identified from the available evidence — a broad recent change touched this file but isn't clearly linked; connect runtime evidence for a code-aware cause" instead of naming the commit. (HOR-451)

## [0.16.0] — 2026-06-30 · horus-source 2.0.2

- Connector credentials are now **encrypted at rest**. Tokens, passwords and connection URLs are AES-256-GCM encrypted into a gitignored `.horus/secrets.local.json`, with the 32-byte master key held by your OS keychain (macOS Keychain, Linux libsecret, Windows DPAPI) — never the repo (`HORUS_SECRET_KEY` overrides for CI/headless). `config.json` keeps only non-secret fields and stays safe to share. New `horus secrets status|migrate|key`, and `horus doctor` now warns when `.horus/` isn't gitignored or config still holds a plaintext secret. Backward-compatible — existing plaintext config still resolves. (HOR-452)
- More trustworthy root causes on real systems (from live connector dogfooding). A recent commit that only touched documentation or reformatted code is no longer blamed as a regression; a broad, diffuse commit that merely touched the implicated file is down-weighted so an evidence-backed runtime cause isn't outranked by it; and an informational/diagnostic log signal can no longer be presented as a confident root cause. (HOR-451)

## [0.15.2] — 2026-06-30 · horus-source 2.0.2

- The source-only data-flow cause (0.15.0) now looks one hop out from the seed — the function it calls or a closely-related function — so it can name a mechanism that lives in a reducer, a library helper, or a sibling method rather than only the entry point. Also recognizes an exact-equality database lookup with no normalization (a value that differs only in case/whitespace returns no rows) as a candidate cause. Still hedged and source-only; never outranks a genuine evidence-backed cause. (HOR-448)

## [0.15.1] — 2026-06-30 · horus-source 2.0.2

- More accurate localization on TypeScript/GraphQL apps. Investigations no longer anchor on auto-generated code (e.g. a `Cart` type in `graphql/generated.tsx`) or other type declarations when a real function with the same name exists — the actual implementation (`cartReducer`, a service method, …) is now chosen as the seed, which also lets the source-only data-flow cause (0.15.0) read the right code. A type you explicitly point at still surfaces. (HOR-447)

## [0.15.0] — 2026-06-30 · horus-source 2.0.2

- Sharper root causes without runtime data. When investigating with no logs/metrics connected, Horus now reads the implicated function's own code and proposes a concrete mechanism — a fixed polling cadence, an in-place state mutation, an unawaited async write, or a hardcoded threshold/retry limit (incl. reference-equality bail-outs) — instead of always falling back to "a recent commit may have caused this". It stays a hedged, clearly-source-only suggestion ("verify against runtime evidence") that never outranks a genuine, evidence-backed cause. (HOR-446)

## [0.14.1] — 2026-06-30 · horus-source 2.0.2

- Fixed: `horus investigate` no longer aborts when a source query fails on an unusual symbol. A seed that resolved to a `#private` class method made the impact lookup 404 (the `#` truncated the request URL), and the whole investigation exited with an error. The symbol id is now encoded correctly, and a failed impact/flows query degrades gracefully (no blast-radius evidence) instead of sinking the run. (HOR-445)

## [0.14.0] — 2026-06-30 · horus-source 2.0.2

- Horus can now LEARN from your feedback. A local, per-tenant reranker (`horus train`) fits on your own outcome-label corpus and reorders candidate causes so the right one surfaces more often — measured honestly against a held-out baseline. It is a ranking aid only: it reorders among causes that already clear Horus's confidence gates and never changes a score, a confidence, or a verdict. Your corpus never leaves your machine; it ships OFF and trains nothing until the corpus is large enough to beat the baseline, then you enable a proven model with `HORUS_RERANK=1`. (HOR-404)

## [0.13.2] — 2026-06-30 · horus-source 2.0.2

- Feedback at the right moment: instead of asking right after an investigation (before you know if Horus was right), Horus now nudges you once on a later run to label a prior investigation that's still unresolved — rate-limited, dismissible, and never in scripts/CI (`--no-input` / `HORUS_NO_INPUT` to disable). This raises the outcome-label rate that powers Horus's measured accuracy over time. (HOR-431)

## [0.13.1] — 2026-06-30 · horus-source 2.0.2

- The `horus report` bug/gap path is now fully discoverable: an unexpected crash nudges you to file an issue, and the command is documented in the CLI reference. Completes the surfacing for the reporting path. (HOR-439)

## [0.13.0] — 2026-06-29 · horus-source 2.0.2

- Benign-variance from code alone: when a service splits its work per segment — separate per-market/region/tenant queues, or a dispatcher like `manageSalesForMarket(market)` fanned out per market — Horus now recognizes the natural per-segment duration variance directly from the code, with no telemetry required, so an expected artifact is no longer reported as a confident wrong root cause. (HOR-438)
- `horus feedback` no longer needs an investigation id — it defaults to your most recent investigation, and a footer after each investigation nudges you to correct a wrong cause. (HOR-431)
- New `horus report [hint]` command and `report_issue` MCP tool: file a Horus bug or capability gap as a pre-filled GitHub issue with an environment block (CLI + source version, OS, Node). Agents can report gaps they hit mid-task. No auth, nothing sent automatically. (HOR-439)
- When the CLI and source-intelligence backend versions drift, the version-pin guard now points you to `horus update` to realign. (HOR-436)

## [0.12.5] — 2026-06-29

- `horus doctor` now health-checks every configured connector, not just the first — misconfigured integrations surface up front. (HOR-437)

## [0.12.4] — 2026-06-29

- Investigations no longer over-anchor on an alert's suggested cause: alert-suggested causes are de-anchored, confidence is recalibrated, and a benign-variance hypothesis is weighed so an expected fluctuation isn't promoted to a confident root cause. (HOR-435)
- Duration-anomaly investigations get real distribution signal: runtime logs are grouped by dimension/region and bimodal (two-population) metrics are detected. (HOR-434)

## [0.12.3] — 2026-06-29 · horus-source 2.0.2

- Self-healing upgrades: upgrading from a pre-2.0 (KuzuDB-era) install now auto-recovers — a legacy or zero-embedding index is detected on host start and re-extracted + re-embedded automatically, no manual reset. (HOR-433)
- Each investigation records a context-only memory; recurring incidents consolidate into a single item with a recurrence count. (HOR-432)

## [0.12.2] — 2026-06-28 · horus-source 2.0.1

- Improved investigation accuracy: seed ranking now weights semantic similarity above raw keyword matching, so investigations surface real core code instead of same-named example/test/demo symbols. (HOR-430)

## [0.12.1] — 2026-06-28

- Fixed: `horus stop` reliably stops its own source host even after an automatic port fallback.
- Docs: README refreshed.

## [0.12.0] — 2026-06-28 · horus-source 2.0.0

- Storage engine rewrite: source-intelligence storage migrated from KuzuDB to SQLite + sqlite-vec (+ FTS5). Lighter install, EOL KuzuDB dependency retired, re-index automatic on upgrade. KuzuDB stays opt-in via `HORUS_SOURCE_STORAGE_BACKEND=kuzu` + the `[kuzu]` extra through the 2.x line, and will be removed in horus-source 3.0.0. (Major: horus-source 2.0.0.)

## [0.11.0] — 2026-06-28

- Axiom connector: `horus connect axiom` (token, region, live dataset pick); Axiom logs flow into investigations as evidence with provenance.

## [0.10.0] — 2026-06-28 · horus-source 1.6.1

- Quality + knowledge graph: interactive Knowledge Graph (Explore + Timeline), Evidence-v2 (subject + typed findings), per-investigation Provenance view, per-tenant accuracy / Insights, and the memory-to-memory link graph (supersedes / contradicts / recurs-with). Plus a large batch of investigation-quality fixes from dogfooding on 50+ real repositories.

## [0.9.0] — 2026-06-28

- Memory + dashboard: the memory system (capture / recall / confirm), the eval/outcome store, self-routing investigations, and the cloud dashboard.

## [0.8.x] — 2026-06-24 to 2026-06-27

- Hardening: dogfood-driven fixes and connector hardening across many real repositories.

## [0.1.0–0.7.0] — 2026-06-17 to 2026-06-23

- Initial development: the core investigation engine, source intelligence, the first connectors, and the CLI foundations.
