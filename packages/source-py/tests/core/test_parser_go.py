from __future__ import annotations

import pytest

from horus_source.core.parsers.go_lang import GoParser, _receiver_type


@pytest.fixture
def go_parser() -> GoParser:
    return GoParser()


def test_parse_function_declaration(go_parser: GoParser) -> None:
    code = """\
package main

func Greet(name string) string {
\treturn "hi " + name
}
"""
    result = go_parser.parse(code, "greet.go")
    fns = [s for s in result.symbols if s.kind == "function"]
    assert len(fns) == 1
    fn = fns[0]
    assert fn.name == "Greet"
    assert fn.start_line == 3
    assert "func Greet" in fn.content
    assert fn.signature == "func Greet(name string) string"
    # Exported (capitalized) → recorded in exports.
    assert "Greet" in result.exports


def test_unexported_function_not_in_exports(go_parser: GoParser) -> None:
    result = go_parser.parse("package main\nfunc helper() {}\n", "h.go")
    fns = [s for s in result.symbols if s.kind == "function"]
    assert fns[0].name == "helper"
    assert "helper" not in result.exports


def test_method_with_receiver_owner(go_parser: GoParser) -> None:
    code = """\
package server

func (s *Server) Start() error {
\treturn nil
}

func (s Server) addr() string {
\treturn s.address
}
"""
    result = go_parser.parse(code, "server.go")
    methods = {s.name: s for s in result.symbols if s.kind == "method"}
    assert set(methods) == {"Start", "addr"}
    # Receiver type is the owner, pointer + receiver name stripped.
    assert methods["Start"].class_name == "Server"
    assert methods["addr"].class_name == "Server"


def test_struct_and_interface_and_alias(go_parser: GoParser) -> None:
    code = """\
package model

type Server struct {
\taddr string
}

type Store interface {
\tGet(id string) (string, error)
}

type ID = string
"""
    result = go_parser.parse(code, "model.go")
    by_name = {s.name: s for s in result.symbols}
    assert by_name["Server"].kind == "class"
    assert by_name["Store"].kind == "interface"
    assert by_name["ID"].kind == "type_alias"
    assert {"Server", "Store", "ID"} <= set(result.exports)


def test_grouped_type_declaration(go_parser: GoParser) -> None:
    code = """\
package model

type (
\tA struct{ x int }
\tB interface{ M() }
)
"""
    result = go_parser.parse(code, "g.go")
    by_name = {s.name: s.kind for s in result.symbols}
    assert by_name.get("A") == "class"
    assert by_name.get("B") == "interface"


def test_imports_single_and_grouped(go_parser: GoParser) -> None:
    code = """\
package main

import (
\t"fmt"
\tgin "github.com/gin-gonic/gin"
)

import "strings"
"""
    result = go_parser.parse(code, "main.go")
    modules = {imp.module: imp for imp in result.imports}
    assert "fmt" in modules
    assert "strings" in modules
    assert "github.com/gin-gonic/gin" in modules
    # Aliased import keeps its alias; names carries the last path segment.
    gin = modules["github.com/gin-gonic/gin"]
    assert gin.alias == "gin"
    assert gin.names == ["gin"]


def test_calls_identifier_and_selector(go_parser: GoParser) -> None:
    code = """\
package main

func run(s *Server) error {
\tr := Default()
\tr.GET("/health", s.health)
\treturn r.Run(s.addr)
}
"""
    result = go_parser.parse(code, "run.go")
    calls = {(c.name, c.receiver) for c in result.calls}
    assert ("Default", "") in calls       # bare identifier call
    assert ("GET", "r") in calls          # selector call with receiver
    assert ("Run", "r") in calls


def test_receiver_type_helper() -> None:
    assert _receiver_type("(s *Server)") == "Server"
    assert _receiver_type("(s Server)") == "Server"
    assert _receiver_type("(*Server)") == "Server"
    assert _receiver_type("(s *Server[T])") == "Server"


def test_realistic_gin_file(go_parser: GoParser) -> None:
    """A representative gin HTTP service — the kind of real Go file we'd index."""
    code = """\
package api

import (
\t"net/http"

\t"github.com/gin-gonic/gin"
)

type Handler struct {
\tstore *Store
}

func NewHandler(store *Store) *Handler {
\treturn &Handler{store: store}
}

func (h *Handler) Register(r *gin.Engine) {
\tr.GET("/users/:id", h.getUser)
}

func (h *Handler) getUser(c *gin.Context) {
\tc.JSON(http.StatusOK, gin.H{"ok": true})
}
"""
    result = go_parser.parse(code, "api/handler.go")
    kinds = {(s.name, s.kind, s.class_name) for s in result.symbols}
    assert ("Handler", "class", "") in kinds
    assert ("NewHandler", "function", "") in kinds
    assert ("Register", "method", "Handler") in kinds
    assert ("getUser", "method", "Handler") in kinds
    # gin import + the route-registering calls are captured.
    assert any(i.module == "github.com/gin-gonic/gin" for i in result.imports)
    assert any(c.name == "GET" for c in result.calls)
    # Exported vs unexported visibility.
    assert "NewHandler" in result.exports and "Register" in result.exports
    assert "getUser" not in result.exports


class TestGoTypeUsage:
    """Dogfood cycle-2 N7: `var Form = formBinding{}` produced no edge — private
    Go types read as dead and struct impact was empty."""

    def test_composite_literal_emits_type_ref(self) -> None:
        parser = GoParser()
        code = (
            "package binding\n\n"
            "type formBinding struct{}\n\n"
            "var Form = formBinding{}\n"
        )
        result = parser.parse(code, "binding/form.go")
        refs = {(r.name, r.kind) for r in result.type_refs}
        assert ("formBinding", "variable") in refs

    def test_params_results_and_fields(self) -> None:
        parser = GoParser()
        code = (
            "package gin\n\n"
            "type Engine struct {\n    pool Pool\n}\n\n"
            "func New(opts Options) *Engine { return nil }\n"
        )
        result = parser.parse(code, "gin.go")
        refs = {(r.name, r.kind) for r in result.type_refs}
        assert ("Options", "param") in refs
        assert ("Pool", "variable") in refs  # struct field
        assert ("Engine", "variable") in refs or ("Engine", "param") in refs or any(r.name == "Engine" for r in result.type_refs)

    def test_builtins_skipped(self) -> None:
        parser = GoParser()
        code = "package x\n\nfunc F(s string, n int) error { return nil }\n"
        result = parser.parse(code, "x.go")
        assert result.type_refs == []
