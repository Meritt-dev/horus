"""Whole-word marker matching for external-system detection.

``files_containing`` backs ``horus architecture``'s integration scan: it looks for
integration names (``stripe``, ``redis``, ``knex``, ...) inside whole-file content. A
plain substring match minted false positives two ways (dogfood 0.21, ~13 repos):

* markers buried MID-identifier — ``stripe`` in ``stripEndSlash``, ``redis`` in
  ``Redistribution``/``prepareDiscriminatorPipeline``, ``knex`` in
  ``findAndLockNextJob``;
* markers merely MENTIONED in comments/JSDoc — ``// Axios, et al.``, ``{@link}`` URLs
  (incl. ``sqlalchemy-a-python-lib``).

So a real hit must be the marker as a whole word — not glued to more identifier
LETTERS on its trailing edge — on a line that isn't comment-shaped. The trailing edge
is the discriminating one: every false positive above has the marker followed by more
letters, while the package-name substrings the marker list deliberately relies on keep
matching because they extend the marker with a prefix or a digit, not a trailing letter
(``pymongo``, ``psycopg2``, ``sqlite3``, ``aiosqlite``, ``redis-py``, ``ioredis``).
"""

from __future__ import annotations

import re
from functools import lru_cache

# A line is a comment when its first non-space characters open one: `//`, `/*`, a
# JSDoc continuation `*`, or a `#` (Python/shell/YAML).
_COMMENT_LINE_RE = re.compile(r"^\s*(//|/\*|\*|#)")


@lru_cache(maxsize=256)
def _marker_re(marker: str) -> re.Pattern[str]:
    # Reject only a trailing identifier LETTER, so `stripEndSlash` fails while a leading
    # prefix (`pymongo`) or a digit suffix (`psycopg2`) still matches.
    return re.compile(re.escape(marker) + r"(?![A-Za-z])", re.IGNORECASE)


def _strip_block_comment(line: str, in_block: bool) -> tuple[str, bool]:
    """Return (code-only remainder of *line*, whether a block comment is still open after it).

    Tracks multi-line ``/* ... */`` spans so a marker mentioned in a block-comment body that
    doesn't lead with ``*`` is not read as a dependency — dogfood 0.21.2: a markdown link
    ``[axios](https://…)`` inside a ``/* … */`` comment minted a false `axios` external. Keyed
    on ``/*``/``*/`` (which, unlike ``//``, do not occur in ordinary URLs), so a `https://` in a
    real string is never mistaken for a comment. String literals are deliberately NOT handled —
    bare-word import strings (`from "graphql"`) are legitimate evidence; disambiguating a data
    string from an import string needs the AST (Batch B / import-edge corroboration)."""
    out: list[str] = []
    i = 0
    n = len(line)
    while i < n:
        if in_block:
            close = line.find("*/", i)
            if close == -1:
                return "".join(out), True
            i = close + 2
            in_block = False
            continue
        opn = line.find("/*", i)
        if opn == -1:
            out.append(line[i:])
            break
        out.append(line[i:opn])
        i = opn + 2
        in_block = True
    return "".join(out), in_block


def content_has_marker(content: str, marker: str) -> bool:
    """True when *marker* appears as a whole word in the CODE (non-comment) part of *content*."""
    if not content or not marker:
        return False
    pattern = _marker_re(marker)
    in_block = False
    for line in content.splitlines():
        code, in_block = _strip_block_comment(line, in_block)
        # A single-line comment (`//`, `#`) or a JSDoc `*` continuation still gates the remainder.
        if _COMMENT_LINE_RE.match(code):
            continue
        if pattern.search(code):
            return True
    return False
