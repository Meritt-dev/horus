"""Capability version of the on-disk index (D6).

A monotonically increasing integer stamped into ``.horus/source/meta.json`` so the
CLI/connector can tell whether an index was built by a host that lacks a newer,
inheritance-aware traversal capability — and, if so, hint (or trigger) a reindex.

The index format itself is versioned separately (``STORE_FORMAT_VERSION``); this
tracks the *analysis capability* the host had when it wrote the index, independent
of the on-disk layout.

Version history
---------------
1. Pre-inheritance-traversal blast radius: impact walked CALLS edges only, so a
   base type's subclasses/implementors never appeared in its blast radius.
2. Inheritance-aware blast radius (B3.4): impact additionally follows incoming
   EXTENDS/IMPLEMENTS edges, so a base type's change includes its subtypes.

Bump this in lockstep with ``EXPECTED_INDEX_CAPABILITY`` in
``packages/core/src/version.ts`` whenever a capability change makes an older index
answer inheritance-dependent commands incompletely.
"""

from __future__ import annotations

INDEX_CAPABILITY_VERSION = 2
