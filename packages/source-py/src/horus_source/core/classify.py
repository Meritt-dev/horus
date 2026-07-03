"""The ONE product/test path classifier for the source graph (Python side).

Mirrors ``packages/core/src/path-classify.ts`` — keep the two pattern lists in
sync. Every graph consumer (search ranking, coupling, dead code, processes,
impact traversal) classifies through here so "what counts as product code" has
exactly one answer.

Product is the default: the classifier only demotes what it can positively
identify, so unknown layouts keep their code visible.
"""

from __future__ import annotations

import re
from typing import Literal

PathKind = Literal["product", "test", "docs", "example", "vendored", "config"]

_VENDORED_DIRS: frozenset[str] = frozenset({
    "node_modules", "vendor", "vendors", "vendored", "third_party", "third-party",
    "dist", "build", ".venv", "venv",
})

_TEST_DIRS: frozenset[str] = frozenset({
    "test", "tests", "__tests__", "spec", "specs", "testdata",
    "fixtures", "__fixtures__", "__mocks__", "e2e",
})

_DOCS_DIRS: frozenset[str] = frozenset({"docs", "doc", "docs_src", "website"})

# Benchmark/demo/sandbox trees are exercised by external runners or exist as
# documentation — grouped with examples because every consumer treats them the same.
_EXAMPLE_DIRS: frozenset[str] = frozenset({
    "examples", "example", "samples", "sample", "demo", "demos",
    "bench", "benches", "benchmark", "benchmarks", "perf", "perf-measures",
    "runtime-tests", "sandbox", "playground", "tutorial", "tutorials",
})

# Test-file naming conventions across the indexed languages. Anchored to the
# BASENAME. `.test.`/`.spec.` accept any extension (co-located JS/TS tests, and
# dead-code previously matched any `.test.` name).
_TEST_FILE_RE = re.compile(
    r"(\.(test|spec)\.[^/.]+$)"
    r"|(^test_[^/]*\.[^/.]+$)"
    r"|(_test\.(py|go|rs)$)"
    r"|(^Test[A-Z][^/]*\.java$)|(Test\.java$)"
    r"|(Spec\.(scala|kt)$)"
    r"|(^conftest\.py$)"
)

_DOCS_FILE_RE = re.compile(r"\.(md|mdx|rst|adoc|txt)$", re.IGNORECASE)

# Root/build tooling config — invoked by build tools, never by repo code
# (mirrors dead-code's axios dogfood findings: gulpfile.js helpers flagged dead).
_CONFIG_FILE_RE = re.compile(
    r"(^|/)(gulpfile|gruntfile|webpack[^/]*|rollup[^/]*|vite[^/]*|babel[^/]*|karma[^/]*"
    r"|eslint[^/]*|prettier[^/]*|jest[^/]*|vitest[^/]*|tsup[^/]*|postcss[^/]*)"
    r"\.(config\.)?[cm]?[jt]s$"
    r"|(^|/)(package\.json|tsconfig[^/]*\.json|pyproject\.toml|Cargo\.toml"
    r"|go\.(mod|sum)|Dockerfile|docker-compose[^/]*\.ya?ml)$"
    r"|(^|/)\.github/",
    re.IGNORECASE,
)


def classify_path(path: str) -> PathKind:
    """Classify a repo-relative (or absolute) file path."""
    normalized = path.replace("\\", "/")
    parts = normalized.split("/")
    base = parts[-1] if parts else normalized
    segments = [p.lower() for p in parts[:-1]]

    for seg in segments:
        if seg in _VENDORED_DIRS:
            return "vendored"
    if _TEST_FILE_RE.search(base):
        return "test"
    for seg in segments:
        if seg in _TEST_DIRS or seg.startswith("test_"):
            return "test"
        if seg in _DOCS_DIRS:
            return "docs"
        if seg in _EXAMPLE_DIRS:
            return "example"
    if _DOCS_FILE_RE.search(base):
        return "docs"
    if _CONFIG_FILE_RE.search(normalized):
        return "config"
    return "product"


def is_product(path: str) -> bool:
    """True when *path* is product code (the traversal/display default)."""
    return classify_path(path) == "product"


def is_test_path(path: str) -> bool:
    """True when *path* is a test file or lives under a test tree."""
    return classify_path(path) == "test"
