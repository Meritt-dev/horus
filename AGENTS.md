# Horus agent guide

## Sunset: this TypeScript implementation is retired

Horus now ships from the Rust implementation in
[Meritt-dev/horus-rust](https://github.com/Meritt-dev/horus-rust), starting with
0.24.0. The `horus` binary on npm (`@merittdev/horus`) and Homebrew is the Rust
build. This repository's Release and NPM Publish workflows are disabled.

Put new features, fixes and releases in horus-rust. Change this repository only
when a task explicitly asks for it, and treat it as a reference for how
behaviour worked before the port.

One exception stays live: every Rust release builds its source-intelligence
backend wheel from `packages/source-py` here (`HORUS_SOURCE_REF`, see
horus-rust `docs/RELEASE.md`). Changes to that package still ship, through the
next Rust release.

## Execution constraints

Never run unit or end-to-end tests locally. Integration, replay and service
lifecycle verification scripts also run only in hosted CI. Normal real-project
background service operation is allowed. Local builds, typechecks and lint are allowed.
Preserve unrelated work, credentials and saved investigation history.

## Find the canonical implementation

Search relevant Linear tickets, repository code, tests, commands and providers
before implementing. Verify ticket status against code; reuse existing paths.
If Linear is unavailable, record that limitation. Do not create or update tickets
without the user's authorization; an explicit ticket waiver is sufficient.

| Area                                           | Owner / entry point                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Investigation, scoring, recall, reports        | HOR-CORE: `packages/engine`                                            |
| Indexing, source intelligence, queue stitching | HOR-SOURCE: `packages/core`, `packages/stitcher`, `packages/source-py` |
| Runtime providers                              | HOR-CONNECTORS: `packages/connectors`                                  |
| Commands, workers, rendering                   | HOR-CLI: `packages/cli`, `apps/horus`                                  |
| Install, packaging, releases                   | HOR-DX: `scripts`, `.github/workflows`                                 |
| Attributed explanation                         | HOR-AI: `packages/ai`; consumes evidence, never creates it             |

Reviewers must read [CODING_STANDARDS.md](CODING_STANDARDS.md).
Current service setup: [operating guide](docs/incident-memory-service.md).
Release evidence: [current receipt](docs/implementation/current-release.json).
Developer checks and bounded CI monitoring: [workflow](docs/development-workflow.md).
