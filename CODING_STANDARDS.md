# Horus review standards

Review the final diff against the user's requested behavior and the surrounding
implementation. Verify which canonical owner is extended; reject duplicate
commands, providers, storage models or configuration paths.

Deterministic runtime evidence outranks source links, correlations, hypotheses
and AI interpretation, in that order. AI cannot turn a hypothesis or prior memory
into confirmed evidence, raise deterministic confidence, or invent missing stages.

Check cross-repository compatibility and deployment order when a Cloud contract
changes. A green mocked check does not establish a connected provider journey;
require relevant hosted coverage and distinguish real operation from fixtures.

Separate CI-tested source, the installed artifact and production image identity.
Historical observations and owner confirmations retain their original revision
scope. Missing measurements or skipped checks cannot satisfy release gates.

Before merge, identify the existing path, owner and ticket (or user waiver),
meaningful hosted verification, and any necessary behavior/setup documentation.
Mechanical lint rules live in scripts/lint.mjs; do not repeat them here.
