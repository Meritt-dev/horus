# Horus Development Rules

This document applies to:

- Claude Code
- Codex
- Gemini
- Kimi
- OpenAI agents
- Any future coding agent

The goal is simple:

> One feature. One owner. One implementation.

---

# Test execution

Never run unit or end-to-end tests locally. Run them only in hosted CI.
Integration, replay, and service lifecycle verification scripts also run only in
hosted CI; do not restart the local verification pilot.

---

# Core Principles

## 1. Reality over documentation

The codebase is the source of truth.

Never assume:

- README is correct
- Linear ticket is current
- Design document is accurate
- Previous agent conclusions are valid

Always verify implementation.

---

## 2. Search before building

Before implementing any feature:

1. Search Linear.
2. Search the repository.
3. Search tests.
4. Search existing commands.
5. Search existing providers.

Do not implement anything until you prove it does not already exist.

---

## 3. Extend, don't replace

If functionality already exists:

- extend it
- improve it
- refactor it

Do not create:

- parallel implementations
- alternative engines
- duplicate providers
- competing command paths

Example:

Bad:

```text
investigate-v2
newTimelineEngine
alternativeCorrelationEngine
```

Good:

```text
extend investigate
improve TimelineEngine
improve CorrelationEngine
```

---

# Ownership Boundaries

## HOR-CORE

Owns:

- investigation engine
- hypotheses
- cause scoring
- confidence scoring
- timeline generation
- incident memory
- replay
- postmortems
- report generation

Packages:

```text
packages/engine
```

---

## HOR-SOURCE

Owns:

- repository indexing
- source intelligence
- queue stitching

Packages:

```text
packages/stitcher
packages/core
```

---

## HOR-CONNECTORS

Owns:

- Elasticsearch
- MongoDB
- Grafana
- Redis
- BullMQ
- Shopify Admin
- future runtime providers

Packages:

```text
packages/connectors
```

---

## HOR-CLI

Owns:

- commands
- UX
- rendering
- help output
- terminal experience
- future TUI

Packages:

```text
packages/cli
apps/horus
```

---

## HOR-DX

Owns:

- install.sh
- horus.sh
- packaging
- releases
- documentation
- onboarding
- binaries

---

## HOR-AI

Owns:

- narrative generation
- report explanation
- evidence citation rendering
- future reasoning layers

AI never replaces deterministic investigation.

AI consumes evidence.

AI does not create evidence.

---

# Linear Rules

Before working on a ticket:

1. Read the ticket.
2. Verify the implementation status.
3. Classify:

```text
VERIFIED
PARTIAL
ACTIVE
DUPLICATE
OBSOLETE
```

If the ticket is already implemented:

Do not reimplement it.

Update the ticket instead.

---

# Code Review Rules

Reviewers must verify:

- feature actually works
- tests exist
- implementation matches ticket
- no duplicate architecture introduced

Reviewers must specifically look for:

- parallel implementations
- duplicate providers
- duplicate commands
- duplicate storage models
- duplicate configuration paths

---

# Investigation Philosophy

Horus is deterministic first.

Order of trust:

1. Runtime evidence
2. Source intelligence
3. Correlation
4. Hypotheses
5. AI explanation

Evidence always wins.

If evidence and AI disagree:

Evidence is correct.

---

# Architecture Rule

Every capability must have exactly one canonical owner.

If you cannot identify the owner:

STOP.

Find the canonical implementation first.

Do not build a second one.

---

# Before Opening a PR

Answer these questions:

1. What existing implementation did I extend?
2. Which project owns this feature?
3. Which ticket owns this work?
4. Did I introduce a duplicate path?
5. Did I update tests?
6. Did I update documentation if behavior changed?

If any answer is unclear:

Do not merge.
