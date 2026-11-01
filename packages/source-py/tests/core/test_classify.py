"""Unit tests for the shared product/test path classifier.

Mirrors packages/core/src/path-classify.ts — if a pattern changes here it must
change there too.
"""

from __future__ import annotations

import pytest

from horus_source.core.classify import classify_path, is_product, is_test_path


class TestTestPaths:
    @pytest.mark.parametrize(
        "path",
        [
            # Co-located test-file naming, all languages.
            "src/router.test.ts",
            "src/jsx/index.test.tsx",
            "lib/api.spec.js",
            "src/entry.spec.tsx",
            "src/types/pino.tst.ts",  # pino's `.tst.ts` type-test convention (dogfood 0.21.1 A5)
            "app/test_models.py",
            "backend/models_test.py",
            "pkg/server_test.go",
            "src/parser_test.rs",
            "src/main/java/OwnerControllerTest.java",
            "src/test_helpers/util.py",  # test_-prefixed directory
            "tests/conftest.py",
            "conftest.py",
            # Test trees.
            "tests/test_login.py",
            "test/login.js",
            "__tests__/a.ts",
            "spec/models/user_spec.rb",
            "specs/user.js",
            "pkg/testdata/golden.json",
            "pkg/fixtures/data.py",
            "src/__fixtures__/queue.ts",
            "src/__mocks__/redis.ts",
            "e2e/checkout.ts",
        ],
    )
    def test_classified_as_test(self, path: str) -> None:
        assert classify_path(path) == "test", path
        assert is_test_path(path) is True
        assert is_product(path) is False

    def test_java_test_prefix_convention(self) -> None:
        assert classify_path("src/TestOwnerController.java") == "test"


class TestDocsExampleVendoredConfig:
    @pytest.mark.parametrize(
        "path",
        ["docs/index.md", "doc/usage.rst", "docs_src/tutorial/t1.py", "website/src/x.ts"],
    )
    def test_docs(self, path: str) -> None:
        assert classify_path(path) == "docs", path

    def test_markdown_anywhere_is_docs(self) -> None:
        assert classify_path("src/README.md") == "docs"

    @pytest.mark.parametrize("path", ["CHANGELOG.markdown", "NOTES.mdown", "readme.mkd"])
    def test_long_form_markdown_extensions_are_docs(self, path: str) -> None:
        # Root long-form Markdown outside a docs/ tree otherwise leaked into
        # external-system detection (dogfood 0.21: axios from CHANGELOG.markdown).
        assert classify_path(path) == "docs", path

    @pytest.mark.parametrize(
        "path",
        [
            "examples/web/app.py",
            "example/quickstart.go",
            "samples/demo.ts",
            "demos/x.py",
            "benchmarks/http/index.ts",
            "benches/parse.rs",
            "perf-measures/startup/run.ts",
            "runtime-tests/deno/x.ts",
            "sandbox/client.js",
            "playground/idea.ts",
            "tutorials/intro.py",
        ],
    )
    def test_examples_and_bench_trees(self, path: str) -> None:
        assert classify_path(path) == "example", path

    @pytest.mark.parametrize(
        "path",
        ["node_modules/pkg/index.js", "vendor/lib.go", "third_party/x.py", "dist/out.js",
         # Yarn Berry blobs and codegen output are vendored, not integrations (dogfood 0.21).
         ".yarn/releases/yarn-3.6.1.cjs", "src/generated/graphql.ts",
         "src/__generated__/schema.d.ts"],
    )
    def test_vendored(self, path: str) -> None:
        assert classify_path(path) == "vendored", path

    @pytest.mark.parametrize(
        "path",
        ["gulpfile.js", "rollup.config.js", "webpack.dev.config.mjs", "package.json",
         "pyproject.toml", ".github/workflows/ci.yml"],
    )
    def test_config(self, path: str) -> None:
        assert classify_path(path) == "config", path


class TestProductIsTheDefault:
    @pytest.mark.parametrize(
        "path",
        [
            "src/server.py",
            "src/app/handler.ts",
            "pydantic/_internal/_core_utils.py",
            "lib/express/index.js",
            # Names that merely CONTAIN test-ish substrings must not over-match.
            "src/contest.py",
            "src/latest.ts",
            "src/protester/api.go",
            "src/attestation.rs",
        ],
    )
    def test_product(self, path: str) -> None:
        assert classify_path(path) == "product", path
        assert is_product(path) is True
        assert is_test_path(path) is False

    def test_empty_path_defaults_to_product(self) -> None:
        assert classify_path("") == "product"

    def test_windows_separators_normalized(self) -> None:
        assert classify_path("src\\__tests__\\a.ts") == "test"
