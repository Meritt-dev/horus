# Horus agent guide

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
