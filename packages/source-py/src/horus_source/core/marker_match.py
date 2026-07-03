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
# JSDoc continuation `*`, or a `#` (Python/shell/YAML). Multi-line block-comment
# bodies that don't lead with `*` aren't caught — that's the accepted heuristic.
_COMMENT_LINE_RE = re.compile(r"^\s*(//|/\*|\*|#)")


@lru_cache(maxsize=256)
def _marker_re(marker: str) -> re.Pattern[str]:
    # Reject only a trailing identifier LETTER, so `stripEndSlash` fails while a leading
    # prefix (`pymongo`) or a digit suffix (`psycopg2`) still matches.
    return re.compile(re.escape(marker) + r"(?![A-Za-z])", re.IGNORECASE)


def content_has_marker(content: str, marker: str) -> bool:
    """True when *marker* appears as a whole word on a non-comment line of *content*."""
    if not content or not marker:
        return False
    pattern = _marker_re(marker)
    for line in content.splitlines():
        if _COMMENT_LINE_RE.match(line):
            continue
        if pattern.search(line):
            return True
    return False
