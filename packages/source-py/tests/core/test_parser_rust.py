from __future__ import annotations

import pytest

from horus_source.core.parsers.rust_lang import RustParser


@pytest.fixture
def rust_parser() -> RustParser:
    return RustParser()


def test_free_function_and_visibility(rust_parser: RustParser) -> None:
    code = """\
pub fn run() {
    helper();
}

fn helper() {}
"""
    result = rust_parser.parse(code, "lib.rs")
    fns = {s.name: s for s in result.symbols if s.kind == "function"}
    assert set(fns) == {"run", "helper"}
    assert "run" in result.exports          # pub
    assert "helper" not in result.exports   # private


def test_struct_enum_trait(rust_parser: RustParser) -> None:
    code = """\
pub struct Server { addr: String }
pub enum State { Idle, Running }
pub trait Handler { fn handle(&self) -> u32; }
"""
    result = rust_parser.parse(code, "model.rs")
    by_name = {s.name: s.kind for s in result.symbols}
    assert by_name["Server"] == "class"
    assert by_name["State"] == "enum"
    assert by_name["Handler"] == "interface"
    # Trait method signature is owned by the trait.
    handle = next(s for s in result.symbols if s.name == "handle")
    assert handle.kind == "method" and handle.class_name == "Handler"


def test_impl_methods_owned_by_type(rust_parser: RustParser) -> None:
    code = """\
struct Server { addr: String }

impl Server {
    pub fn new(addr: String) -> Self { Server { addr } }
    async fn start(&self) -> Result<(), Error> {
        self.listen().await
    }
}
"""
    result = rust_parser.parse(code, "server.rs")
    methods = {s.name: s for s in result.symbols if s.kind == "method"}
    assert methods["new"].class_name == "Server"
    assert methods["start"].class_name == "Server"   # async fn still resolves
    # No free functions — both are impl methods.
    assert not [s for s in result.symbols if s.kind == "function"]


def test_impl_trait_for_type_heritage(rust_parser: RustParser) -> None:
    code = """\
impl Handler for Server {
    fn handle(&self) -> u32 { 0 }
}
"""
    result = rust_parser.parse(code, "impl.rs")
    assert ("Server", "implements", "Handler") in result.heritage
    # The impl method is owned by the target type.
    handle = next(s for s in result.symbols if s.name == "handle")
    assert handle.class_name == "Server"


def test_plain_impl_has_no_heritage(rust_parser: RustParser) -> None:
    result = rust_parser.parse("struct S; impl S { fn m(&self) {} }", "s.rs")
    assert result.heritage == []


def test_use_imports_flatten(rust_parser: RustParser) -> None:
    code = """\
use std::collections::HashMap;
use actix_web::{web, App, HttpServer};
use serde::Serialize as Ser;
"""
    result = rust_parser.parse(code, "main.rs")
    modules = {imp.module: imp for imp in result.imports}
    assert "std::collections::HashMap" in modules
    # Grouped use expands to each leaf with the shared prefix.
    assert "actix_web::web" in modules
    assert "actix_web::App" in modules
    assert "actix_web::HttpServer" in modules
    # Aliased use keeps the alias.
    assert modules["serde::Serialize"].alias == "Ser"


def test_calls_field_scoped_and_bare(rust_parser: RustParser) -> None:
    code = """\
fn run() {
    let s = Server::new("x".into());
    s.start();
    helper();
}
"""
    result = rust_parser.parse(code, "run.rs")
    calls = {(c.name, c.receiver) for c in result.calls}
    assert ("new", "Server") in calls    # scoped Type::method
    assert ("start", "s") in calls        # field x.method
    assert ("helper", "") in calls        # bare


def test_realistic_actix_file_endtoend(rust_parser: RustParser) -> None:
    code = """\
use actix_web::{web, App, HttpServer, HttpResponse};

pub struct AppState {
    db: Pool,
}

pub trait Repo {
    fn find(&self, id: u64) -> Option<User>;
}

impl Repo for AppState {
    fn find(&self, id: u64) -> Option<User> {
        self.db.query(id)
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| App::new()).bind("127.0.0.1:8080")?.run().await
}
"""
    result = rust_parser.parse(code, "main.rs")
    by = {(s.name, s.kind, s.class_name) for s in result.symbols}
    assert ("AppState", "class", "") in by
    assert ("Repo", "interface", "") in by
    assert ("find", "method", "AppState") in by
    assert ("main", "function", "") in by   # async fn under #[tokio::main]
    assert ("AppState", "implements", "Repo") in result.heritage
    assert any(i.module.startswith("actix_web") for i in result.imports)
    assert any(c.name == "query" and c.receiver == "self.db" for c in result.calls)


class TestCfgTestModMarker:
    """Dogfood P1: 149 of clap's dead flags were symbols in `#[cfg(test)] mod`
    inline unit tests — runner-invoked, never called in-repo."""

    def test_symbols_in_cfg_test_mod_carry_marker(self) -> None:
        parser = RustParser()
        code = (
            "pub fn real() {}\n\n"
            "#[cfg(test)]\n"
            "mod tests {\n"
            "    #[test]\n"
            "    fn verifies_real() { super::real(); }\n"
            "    fn helper() {}\n"
            "}\n"
        )
        result = parser.parse(code, "src/lib.rs")
        by_name = {s.name: s for s in result.symbols}
        assert "cfg(test)" in by_name["verifies_real"].decorators
        assert "cfg(test)" in by_name["helper"].decorators
        assert by_name["real"].decorators == []

    def test_cfg_all_variant_detected(self) -> None:
        parser = RustParser()
        code = '#[cfg(all(test, feature = "x"))]\nmod tests {\n    fn t() {}\n}\n'
        result = parser.parse(code, "src/lib.rs")
        assert "cfg(test)" in {s.name: s for s in result.symbols}["t"].decorators

    def test_non_test_mod_not_marked(self) -> None:
        parser = RustParser()
        code = "mod inner {\n    fn plain() {}\n}\n"
        result = parser.parse(code, "src/lib.rs")
        assert {s.name: s for s in result.symbols}["plain"].decorators == []


class TestTraitImplMarker:
    def test_trait_impl_methods_carry_marker(self) -> None:
        parser = RustParser()
        code = (
            "struct Id(u32);\n"
            "impl From<u32> for Id {\n"
            "    fn from(v: u32) -> Self { Id(v) }\n"
            "}\n"
            "impl Id {\n"
            "    fn inherent(&self) -> u32 { self.0 }\n"
            "}\n"
        )
        result = parser.parse(code, "src/lib.rs")
        by_name = {s.name: s for s in result.symbols}
        assert "trait_impl" in by_name["from"].decorators
        assert by_name["inherent"].decorators == []  # inherent impls stay eligible
