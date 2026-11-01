"""Whole-word, non-comment marker matching for external-system detection (dogfood 0.21, A3)."""

from __future__ import annotations

from horus_source.core.marker_match import content_has_marker


class TestContentHasMarker:
    def test_rejects_marker_buried_mid_identifier(self) -> None:
        # The false positives that motivated the fix: marker glued to trailing letters.
        assert not content_has_marker("export function stripEndSlash(s) {}", "stripe")
        assert not content_has_marker("const x = Redistribution(y)", "redis")
        assert not content_has_marker("await findAndLockNextJob()", "knex")
        assert not content_has_marker("prepareDiscriminatorPipeline()", "redis")

    def test_matches_standalone_identifier(self) -> None:
        assert content_has_marker("const redis = createClient()", "redis")
        assert content_has_marker("import Redis from 'ioredis'", "redis")  # case-insensitive

    def test_matches_package_name_substrings(self) -> None:
        # Prefix and digit/hyphen suffixes extend the marker without a trailing LETTER.
        assert content_has_marker("from pymongo import MongoClient", "mongo")
        assert content_has_marker("import psycopg2", "psycopg")
        assert content_has_marker("import aiosqlite", "sqlite")
        assert content_has_marker("import sqlite3", "sqlite")
        assert content_has_marker("import { drizzle } from 'drizzle-orm'", "drizzle-orm")

    def test_skips_comment_shaped_lines(self) -> None:
        assert not content_has_marker("// Axios, et al. are supported", "axios")
        assert not content_has_marker(" * {@link https://sqlalchemy.org}", "sqlalchemy")
        assert not content_has_marker("/* uses stripe internally */", "stripe")
        assert not content_has_marker("# celery config lives here", "celery")

    def test_matches_non_comment_line_amid_comments(self) -> None:
        content = "// header comment\nconst q = new Queue('bullmq')\n// trailer"
        assert content_has_marker(content, "bullmq")

    def test_skips_marker_inside_multiline_block_comment(self) -> None:
        # dogfood 0.21.2: a markdown link inside a /* */ block whose body line does NOT
        # lead with `*` (jest-message-util) minted a false `axios` external.
        content = (
            "export function foo() {}\n"
            "/*\n"
            "See [verror](https://npm.im/verror) or [axios](https://axios-http.com).\n"
            "*/\n"
            "return foo\n"
        )
        assert not content_has_marker(content, "axios")

    def test_block_comment_does_not_swallow_trailing_code(self) -> None:
        # A block comment that opens and closes, then real code with the marker, on later lines.
        content = "/* a mongo note */\nconst c = connectRedis()\n"
        assert content_has_marker(content, "redis")  # real code after the block
        assert not content_has_marker(content, "mongo")  # only inside the block

    def test_inline_block_comment_span_removed_keeps_code(self) -> None:
        # `redis` in code before an inline /* */ still matches; `stripe` only in the span does not.
        assert content_has_marker("const r = redis /* not stripe */", "redis")
        assert not content_has_marker("const r = plain /* uses stripe */", "stripe")

    def test_url_with_double_slash_is_not_a_block_comment(self) -> None:
        # `//` in https:// must NOT be treated as a block-comment open (only `/*` is).
        assert content_has_marker('const u = "redis://localhost"', "redis")

    def test_empty_inputs(self) -> None:
        assert not content_has_marker("", "redis")
        assert not content_has_marker("redis", "")
