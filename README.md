<p align="center">
  <img src="https://meritt-dev-assets.s3.eu-central-1.amazonaws.com/public/horus-logo-dark-20260614171147.svg" width="72" alt="Horus" />
</p>

# Horus

**Understand what happened.**

Open-source incident investigation. Horus connects Elasticsearch, Sentry, Grafana, MongoDB, Postgres, Redis (incl. BullMQ queues), Axiom logs, Shopify Admin, Azure Monitor, CloudWatch Logs, Google Cloud Logging, Prometheus, Azure Service Bus, Kafka, Firestore, SQL Server, and source intelligence into deterministic reports.

Horus is a single native CLI binary, and it only reads from production.

[horus.sh](https://horus.sh) · [github.com/meritt-dev/horus](https://github.com/meritt-dev/horus)

```bash
curl -fsSL https://horus.sh/install.sh | bash
npm install -g @merittdev/horus
brew install meritt-dev/tap/horus
```

---

## What Horus does

Horus reads from the systems you already run and rebuilds the incident from what they recorded.

Instead of a page of raw logs, you get a **deterministic report** that links runtime signals to the code behind them. It lists suspected causes (ranked), hypotheses, evidence, gaps, and next actions. Optional `--ai` adds an Anthropic narrative on top, written from that evidence.

Horus sits on top of the monitoring and observability tools you already run. They detect problems and show signals. Horus reads from them and works out what happened.

## Getting started

```bash
cd your-service
horus init                    # index the repo, start the source host, write .horus/config.json
horus connect elasticsearch   # optional runtime connectors (see `horus connect --help`)
horus doctor
horus investigate "checkout latency spike"
horus investigations          # list saved IDs
horus replay <id>
horus postmortem <id>
```

`horus --help` lists every command.

## How it works

| Runtime and source | Investigation engine | Report |
|---|---|---|
| Elasticsearch · Axiom · cloud logs · Sentry errors | Correlation | Suspected causes (ranked) |
| Grafana · Prometheus metrics | Timeline | Hypotheses + confidence |
| MongoDB · Postgres · SQL Server · Firestore · Redis state | Cause ranking | Evidence + gaps |
| BullMQ · Kafka · Azure Service Bus queues | | Next actions |
| Source graph + git | | |

Pipeline: **Evidence → Correlation → Hypotheses → Timeline → Report**

## Example output (illustrative)

```bash
cd ~/code/atlas-payments
horus investigate --env production "checkout latency spike"
```

```text
# Investigation inv-347
Hint: checkout latency spike

## Suspected causes (ranked)
1. [0.82 / high] Redis connection pool exhaustion [↑ queue]

## Hypotheses
  [supported] [0.78] queue: backlog growth preceded latency spike

## Evidence gaps
  - queue runtime state: worker heartbeat unavailable

## Evidence
- ev-01 [elasticsearch/error] Request timeout increase
- ev-04 [bullmq/queue] checkout-jobs backlog growth

## Next actions
- Inspect worker concurrency changes in deploy #784
```

## Principles

Horus only reads. It never writes to your production systems.

The engine is deterministic. The same evidence gives the same report, and `--ai` only adds a narrative on top.

Connectors read straight from your own clusters. Investigations and incident memory stay in a local SQLite store (`~/.horus/horus-rust.db`) and sync with Horus Cloud when the repo is linked.

The repo you run in is the project. Its `.horus/config.json` holds the config, and `--config <path>` points Horus at another repo.

Every investigation and analysis command takes `--json` (compact by default, `--full` for the raw structure). Each result carries a `nextSteps` array that an agent can follow.

## Core commands

| Command | What it does |
| --- | --- |
| `horus init [--env <e>]` | Set up the current repo: config, source-intelligence host, index, queue map |
| `horus connect <type>` | Add or update a runtime connector (`horus connect --help` lists the types), or `ai` for an AI provider |
| `horus status [--env]` | Per-project/env connector-health matrix |
| `horus doctor` | Check local readiness: CLI version, git root, `.horus` config, source-intelligence setup |
| `horus investigate --env <e> "<hint>"` | Full deterministic investigation report |
| `horus packet <hint\|savedId> [--for claude] [--json]` | Short briefing sized for a coding agent's context window, with confidence stated plainly |
| `horus logs` · `state` · `metrics` · `queues [--live]` | Single-source evidence: error signatures, application state, metrics, queue topology and live depths |
| `horus search` · `explain` · `blast-radius` · `architecture` · `what-changed` · `changes` | Source-aware code intelligence |
| `horus memory <show\|add\|list\|link\|...>` | Inspect and author incident memory |
| `horus feedback <id> [--resolved] [--note] [--cause]` | Record the outcome of an investigation |
| `horus hosts [--reap]` · `horus stop [--all]` | List or stop source-intelligence hosts |
| `horus report` | File a Horus bug or capability gap as a pre-filled GitHub issue (nothing is sent automatically) |
| `horus update` | Update Horus (through npm or Homebrew when installed that way) |

## For coding agents

Coding agents can call Horus for evidence before they guess at a cause. Install a skill that tells your agent when to use it, or expose the knowledge index over MCP:

```bash
horus skill install claude    # also: codex · gemini · cursor · generic
horus mcp                     # expose the local knowledge index to agents over MCP (stdio)
```

## Configuration

Config keeps code and runtime apart. Code belongs to the project: `repositories[]`, each served by its own source-intelligence host. Runtime belongs to the environment: `environments[].connectors`, scoped per project and environment, with no global connector defaults.

A repo carries `.horus/config.json`, discovered by walking up from the working directory like `.git`. `horus.config.{js,ts}` files are also supported and are loaded through an installed `node`.

Secrets stay out of git. `horus connect` encrypts connector credentials into `.horus/secrets.local.json` (never `config.json`) and adds `.horus/` to `.gitignore`. Environment variables also work at runtime. See [horus.sh/docs/security](https://horus.sh/docs/security).

## Source intelligence

Horus expects source intelligence to be present. The bundled backend (code graph, semantic search, impact analysis, ownership, tree-sitter across TypeScript/JavaScript, Python, Go, Java and Rust) ships as `horus_source.whl` beside the binary, and `horus init` installs it with [uv](https://docs.astral.sh/uv/). Horus talks to it over HTTP/MCP only.

Horus adds one thing the backend lacks. It stitches queue boundaries, linking a producer's `queue.add(...)` to the consumer's `@Processor` handler.

> If the backend is unavailable, Horus still collects runtime evidence, but source context, impact analysis, change analysis and queue stitching are degraded.

## Install

See [horus.sh/docs/installation](https://horus.sh/docs/installation) for full install, update and uninstall instructions.

```sh
curl -fsSL https://horus.sh/install.sh | bash   # binary + backend
npm i -g @merittdev/horus                       # npm (macOS / Linux, arm64 / x64)
brew install meritt-dev/tap/horus               # Homebrew
```

The npm and Homebrew packages bundle the matching backend wheel. If you install the bare binary from [GitHub Releases](https://github.com/meritt-dev/horus/releases), run `horus update --force` once to fetch the wheel.

Requirements: macOS or Linux (arm64 / x64), `git`, and Python 3.11+ with uv for the source backend. The binary itself needs no Node.js.

If something goes wrong, run `horus doctor`.

## Upgrading from the TypeScript horus (≤ 0.23.0)

From 0.24.0 Horus is this Rust implementation, on every channel. It is a command-for-command port of the TypeScript CLI (now archived at [Meritt-dev/horus-ts](https://github.com/Meritt-dev/horus-ts)): same commands, flags, help text, output and exit codes.

| Installed with | Upgrade |
| --- | --- |
| npm | `npm i -g @merittdev/horus@latest` |
| Homebrew | `brew upgrade horus` (the formula no longer depends on `node`) |
| curl | `curl -fsSL https://horus.sh/install.sh \| bash` |

Config and secrets in `~/.horus` and `.horus/config.json` are read as they are.

The TS CLI kept investigations and memory in PGlite at `~/.horus/horus.db`. Copy them into the new SQLite store once (needs `node`/`npx`; the TS store is only read):

```sh
horus db migrate-from-ts
```

Until you do, `horus` prints a one-line reminder while the new store is empty. Re-running the migration is safe.

We benchmarked both CLIs on 12 real repositories ([docs/BENCHMARK.md](docs/BENCHMARK.md)). The Rust build starts in 5 ms instead of 158 ms, idles at 10 MB instead of 153 MB, and runs 2.5 to 11.8× faster per project. Output matched 98 to 100% on 11 of the repos, and 66 of 76 cases were identical on the main one. The rest differ only by local history, live data or the clock. Intended differences are listed in [DIVERGENCES.md](DIVERGENCES.md).

## Build from source

```sh
HORUS_VERSION=0.24.4 cargo build --release -p horus-cli   # → target/release/horus
```

Cross-platform builds are covered in [PORTING.md](PORTING.md), and cutting a release in [docs/RELEASE.md](docs/RELEASE.md).

```
crates/
  core/         evidence model, config schema, project/env resolution, version pins
  connectors/   provider contracts, source intelligence client, runtime connectors
  stitcher/     queue-boundary stitcher
  db/           local SQLite store
  engine/       deterministic investigation pipeline (timeline, correlation, hypotheses, gaps)
  ai/           optional narrative layer
  knowledge/    local project-knowledge index
  eval/         read-only accuracy harness
  cli/          the horus binary
```

IncidentBench, the open benchmark for startup recall, is described in [docs/incident-bench.md](docs/incident-bench.md).

## License

MIT
