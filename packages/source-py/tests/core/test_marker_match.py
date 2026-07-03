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

    def test_empty_inputs(self) -> None:
        assert not content_has_marker("", "redis")
        assert not content_has_marker("redis", "")
