from __future__ import annotations

import pytest

from horus_source.core.parsers.typescript import TypeScriptParser


@pytest.fixture
def ts_parser() -> TypeScriptParser:
    return TypeScriptParser(dialect="typescript")

@pytest.fixture
def js_parser() -> TypeScriptParser:
    return TypeScriptParser(dialect="javascript")
def test_parse_ts_function_declaration(ts_parser: TypeScriptParser) -> None:
    code = """\
function greet(name: string): string {
    return `Hello, ${name}`;
}
"""
    result = ts_parser.parse(code, "greet.ts")

    functions = [s for s in result.symbols if s.kind == "function"]
    assert len(functions) == 1

    fn = functions[0]
    assert fn.name == "greet"
    assert fn.start_line == 1
    assert fn.end_line == 3
    assert "function greet" in fn.content
def test_parse_arrow_function_with_types(ts_parser: TypeScriptParser) -> None:
    code = """\
const validate = (user: User): boolean => {
    return user.isValid();
};
"""
    result = ts_parser.parse(code, "validate.ts")

    functions = [s for s in result.symbols if s.kind == "function"]
    assert len(functions) == 1
    assert functions[0].name == "validate"

    # User should appear as a param type ref; boolean is built-in and skipped.
    type_names = [t.name for t in result.type_refs]
    assert "User" in type_names
    assert "boolean" not in type_names

    # Verify the param_name for the User type ref.
    user_refs = [t for t in result.type_refs if t.name == "User"]
    assert len(user_refs) == 1
    assert user_refs[0].kind == "param"
    assert user_refs[0].param_name == "user"
def test_parse_class_with_heritage(ts_parser: TypeScriptParser) -> None:
    code = """\
class Admin extends User implements Serializable {
    save(): void {
        this.validate();
    }
}
"""
    result = ts_parser.parse(code, "admin.ts")

    classes = [s for s in result.symbols if s.kind == "class"]
    assert len(classes) == 1
    assert classes[0].name == "Admin"

    methods = [s for s in result.symbols if s.kind == "method"]
    assert len(methods) == 1
    assert methods[0].name == "save"
    assert methods[0].class_name == "Admin"

    # Heritage: extends User, implements Serializable
    assert ("Admin", "extends", "User") in result.heritage
    assert ("Admin", "implements", "Serializable") in result.heritage

    # Call: this.validate()
    this_calls = [c for c in result.calls if c.receiver == "this"]
    assert len(this_calls) == 1
    assert this_calls[0].name == "validate"
def test_parse_interface(ts_parser: TypeScriptParser) -> None:
    code = """\
interface AuthConfig {
    secret: string;
    timeout: number;
}
"""
    result = ts_parser.parse(code, "config.ts")

    interfaces = [s for s in result.symbols if s.kind == "interface"]
    assert len(interfaces) == 1
    assert interfaces[0].name == "AuthConfig"
    assert interfaces[0].start_line == 1
    assert interfaces[0].end_line == 4
def test_parse_type_alias(ts_parser: TypeScriptParser) -> None:
    code = """\
type UserId = string | number;
"""
    result = ts_parser.parse(code, "types.ts")

    type_aliases = [s for s in result.symbols if s.kind == "type_alias"]
    assert len(type_aliases) == 1
    assert type_aliases[0].name == "UserId"
def test_parse_imports(ts_parser: TypeScriptParser) -> None:
    code = """\
import { User, Admin } from './models';
import * as utils from '../utils';
import express from 'express';
"""
    result = ts_parser.parse(code, "app.ts")

    assert len(result.imports) == 3

    # Named imports from relative module.
    named = [i for i in result.imports if i.module == "./models"][0]
    assert set(named.names) == {"User", "Admin"}
    assert named.is_relative is True
    assert named.alias == ""

    # Namespace import from relative module.
    ns = [i for i in result.imports if i.module == "../utils"][0]
    assert ns.names == ["utils"]
    assert ns.alias == "utils"
    assert ns.is_relative is True

    # Default import from package.
    default = [i for i in result.imports if i.module == "express"][0]
    assert default.names == ["express"]
    assert default.is_relative is False
def test_parse_javascript(js_parser: TypeScriptParser) -> None:
    code = """\
function hello(name) {
    console.log(name);
}
const foo = require('./bar');
"""
    result = js_parser.parse(code, "app.js")

    # 1 function
    functions = [s for s in result.symbols if s.kind == "function"]
    assert len(functions) == 1
    assert functions[0].name == "hello"

    # 1 import via require
    assert len(result.imports) == 1
    imp = result.imports[0]
    assert imp.module == "./bar"
    assert imp.names == ["foo"]
    assert imp.is_relative is True

    # Calls include console.log
    log_calls = [c for c in result.calls if c.name == "log"]
    assert len(log_calls) == 1
    assert log_calls[0].receiver == "console"
def test_invalid_dialect_raises() -> None:
    with pytest.raises(ValueError, match="Unknown dialect"):
        TypeScriptParser(dialect="coffeescript")

def test_empty_source(ts_parser: TypeScriptParser) -> None:
    result = ts_parser.parse("", "empty.ts")
    assert result.symbols == []
    assert result.imports == []
    assert result.calls == []
    assert result.type_refs == []

def test_interface_extends_heritage(ts_parser: TypeScriptParser) -> None:
    code = """\
interface Foo extends Bar {
    x: number;
}
"""
    result = ts_parser.parse(code, "foo.ts")

    interfaces = [s for s in result.symbols if s.kind == "interface"]
    assert len(interfaces) == 1
    assert ("Foo", "extends", "Bar") in result.heritage

def test_function_expression(js_parser: TypeScriptParser) -> None:
    code = """\
const add = function(a, b) { return a + b; };
"""
    result = js_parser.parse(code, "math.js")

    functions = [s for s in result.symbols if s.kind == "function"]
    assert len(functions) == 1
    assert functions[0].name == "add"

def test_variable_type_annotation(ts_parser: TypeScriptParser) -> None:
    code = """\
const config: AppConfig = getConfig();
"""
    result = ts_parser.parse(code, "config.ts")

    var_types = [t for t in result.type_refs if t.kind == "variable"]
    assert len(var_types) == 1
    assert var_types[0].name == "AppConfig"

def test_return_type_ref(ts_parser: TypeScriptParser) -> None:
    code = """\
function getUser(): UserModel {
    return db.find();
}
"""
    result = ts_parser.parse(code, "user.ts")

    return_types = [t for t in result.type_refs if t.kind == "return"]
    assert len(return_types) == 1
    assert return_types[0].name == "UserModel"
def test_new_expression_simple(js_parser: TypeScriptParser) -> None:
    code = """\
function init() {
    const mgr = new AchievementManager(this);
}
"""
    result = js_parser.parse(code, "game.js")

    new_calls = [c for c in result.calls if c.name == "AchievementManager"]
    assert len(new_calls) == 1
    assert new_calls[0].line == 2
    assert new_calls[0].receiver == ""

def test_new_expression_with_member(ts_parser: TypeScriptParser) -> None:
    code = """\
const db = new pg.Client();
"""
    result = ts_parser.parse(code, "db.ts")

    new_calls = [c for c in result.calls if c.name == "Client"]
    assert len(new_calls) == 1
    assert new_calls[0].receiver == "pg"

def test_new_expression_callback_args(js_parser: TypeScriptParser) -> None:
    code = """\
const watcher = new FileWatcher(onChange);
"""
    result = js_parser.parse(code, "watcher.js")

    new_calls = [c for c in result.calls if c.name == "FileWatcher"]
    assert len(new_calls) == 1
    assert "onChange" in new_calls[0].arguments

def test_new_expression_cookie_clicker_pattern(js_parser: TypeScriptParser) -> None:
    """Real-world pattern: exported class instantiated with ``new``."""
    code = """\
import { AchievementManager } from "./achievements.js";

export class Game {
    constructor() {
        this.achievementManager = new AchievementManager(this);
        this.prestige = new PrestigeManager(this);
    }

    start() {
        this.achievementManager.check();
    }
}
"""
    result = js_parser.parse(code, "game.js")

    # Both new expressions should create calls.
    call_names = [c.name for c in result.calls]
    assert "AchievementManager" in call_names
    assert "PrestigeManager" in call_names

    # Method call on instance should also be captured.
    check_calls = [c for c in result.calls if c.name == "check"]
    assert len(check_calls) == 1
    assert "achievementManager" in check_calls[0].receiver
def test_module_exports_identifier(js_parser: TypeScriptParser) -> None:
    code = """\
class AchievementManager {}
module.exports = AchievementManager;
"""
    result = js_parser.parse(code, "achievements.js")

    assert "AchievementManager" in result.exports

def test_module_exports_object(js_parser: TypeScriptParser) -> None:
    code = """\
class Foo {}
class Bar {}
module.exports = { Foo, Bar };
"""
    result = js_parser.parse(code, "lib.js")

    assert "Foo" in result.exports
    assert "Bar" in result.exports


class TestTsDecoratorArgs:
    """NestJS-style decorators wire a runtime signal name to a handler symbol.

    The TypeScript parser previously captured no decorators at all; it now records both
    decorator names and their string-literal arguments (queue/route/job/pattern names).
    """

    def test_processor_queue_name_on_class(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "@Processor('MANAGE_SALES')\n"
            "@Injectable()\n"
            "export class SalesProcessor {}\n"
        )
        result = ts_parser.parse(code, "sales.processor.ts")
        cls = next(s for s in result.symbols if s.kind == "class")
        assert cls.decorators == ["Processor", "Injectable"]
        assert cls.decorator_args == ["MANAGE_SALES"]

    def test_process_job_name_on_method(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "export class SalesProcessor {\n"
            "  @Process('sync')\n"
            "  async manageSalesForMarket(job: Job): Promise<void> { return; }\n"
            "}\n"
        )
        result = ts_parser.parse(code, "sales.processor.ts")
        method = next(s for s in result.symbols if s.kind == "method")
        assert method.name == "manageSalesForMarket"
        assert method.decorators == ["Process"]
        assert method.decorator_args == ["sync"]

    def test_http_route_decorator(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "export class OrdersController {\n"
            "  @Get('/orders')\n"
            "  getOrders() {}\n"
            "}\n"
        )
        result = ts_parser.parse(code, "orders.controller.ts")
        method = next(s for s in result.symbols if s.name == "getOrders")
        assert method.decorator_args == ["/orders"]

    def test_message_pattern_decorator(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "export class Listener {\n"
            "  @MessagePattern('order.created')\n"
            "  onOrder() {}\n"
            "}\n"
        )
        result = ts_parser.parse(code, "listener.ts")
        method = next(s for s in result.symbols if s.name == "onOrder")
        assert method.decorator_args == ["order.created"]

    def test_no_arg_decorator_has_empty_args(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "export class Foo {\n"
            "  @Get()\n"
            "  list() {}\n"
            "}\n"
        )
        result = ts_parser.parse(code, "foo.ts")
        method = next(s for s in result.symbols if s.name == "list")
        assert method.decorators == ["Get"]
        assert method.decorator_args == []

    def test_undecorated_method_has_empty_decorators(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "export class Foo {\n"
            "  plain() {}\n"
            "}\n"
        )
        result = ts_parser.parse(code, "foo.ts")
        method = next(s for s in result.symbols if s.name == "plain")
        assert method.decorators == []
        assert method.decorator_args == []

    def test_non_exported_decorated_class(self, ts_parser: TypeScriptParser) -> None:
        # Tree-sitter nests the decorator INSIDE a non-exported class_declaration rather than
        # as a preceding sibling; both placements must be captured.
        code = "@Controller('cats')\nclass CatsController {}\n"
        result = ts_parser.parse(code, "cats.controller.ts")
        cls = next(s for s in result.symbols if s.kind == "class")
        assert cls.decorators == ["Controller"]
        assert cls.decorator_args == ["cats"]


class TestDiFieldCapture:
    """The TS parser must capture {field: Type} DI maps on the CLASS symbol.

    NestJS constructor parameter-properties and typed field declarations declare
    instance fields that later let ``this.<field>.<method>()`` resolve to the
    concrete injected service.
    """

    def test_constructor_parameter_properties(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "@Injectable()\n"
            "export class UsersService {\n"
            "  constructor(\n"
            "    private readonly prismaService: PrismaService,\n"
            "    public mailer: MailerService,\n"
            "  ) {}\n"
            "}\n"
        )
        result = ts_parser.parse(code, "users.service.ts")
        cls = next(s for s in result.symbols if s.kind == "class")
        assert cls.di_fields == {
            "prismaService": "PrismaService",
            "mailer": "MailerService",
        }

    def test_typed_field_declarations(self, ts_parser: TypeScriptParser) -> None:
        code = (
            "export class CacheService {\n"
            "  private readonly cache: CacheManager;\n"
            "  protected store: RedisStore;\n"
            "}\n"
        )
        result = ts_parser.parse(code, "cache.service.ts")
        cls = next(s for s in result.symbols if s.kind == "class")
        assert cls.di_fields == {"cache": "CacheManager", "store": "RedisStore"}

    def test_plain_constructor_param_is_not_a_field(self, ts_parser: TypeScriptParser) -> None:
        # A parameter without accessibility/readonly is NOT an instance field,
        # and builtin-typed params are skipped.
        code = (
            "export class Foo {\n"
            "  constructor(private repo: UserRepo, count: number, plain: BarService) {}\n"
            "}\n"
        )
        result = ts_parser.parse(code, "foo.ts")
        cls = next(s for s in result.symbols if s.kind == "class")
        assert cls.di_fields == {"repo": "UserRepo"}

    def test_class_without_di_has_empty_map(self, ts_parser: TypeScriptParser) -> None:
        code = "export class Empty {\n  doWork() {}\n}\n"
        result = ts_parser.parse(code, "empty.ts")
        cls = next(s for s in result.symbols if s.kind == "class")
        assert cls.di_fields == {}


class TestJsxComponentUsage:
    """Dogfood P1: `<Content />` is an invocation of Content, but produced no call
    edge — every JSX component read as dead code."""

    @pytest.fixture
    def tsx_parser(self) -> TypeScriptParser:
        return TypeScriptParser(dialect="tsx")

    def test_self_closing_and_paired_elements_are_calls(
        self, tsx_parser: TypeScriptParser
    ) -> None:
        code = """\
const Content = () => <p>hi</p>;
const Form = () => <form />;
export const Page = () => (
  <div>
    <Content />
    <Form>inner</Form>
  </div>
);
"""
        result = tsx_parser.parse(code, "src/page.tsx")
        called = {c.name for c in result.calls}
        assert "Content" in called
        assert "Form" in called

    def test_intrinsic_lowercase_tags_are_not_calls(
        self, tsx_parser: TypeScriptParser
    ) -> None:
        code = 'export const X = () => <div className="a"><span /></div>;\n'
        result = tsx_parser.parse(code, "src/x.tsx")
        called = {c.name for c in result.calls}
        assert "div" not in called
        assert "span" not in called

    def test_member_component_usage_records_property_name(
        self, tsx_parser: TypeScriptParser
    ) -> None:
        code = "export const Y = () => <UI.Widget />;\n"
        result = tsx_parser.parse(code, "src/y.tsx")
        widget = [c for c in result.calls if c.name == "Widget"]
        assert widget and widget[0].receiver == "UI"


class TestPropertyAssignmentFunctions:
    """Dogfood cycle-2 N6: express's ENTIRE API (`res.send = function send(){}`,
    `app.use = function use(fn){}`) was invisible — 0 methods repo-wide."""

    def test_receiver_property_function_is_a_method(self, js_parser: TypeScriptParser) -> None:
        code = (
            "var res = Object.create(null);\n"
            "res.send = function send(body) {\n  return this.end(body);\n};\n"
            "res.json = (obj) => res.send(JSON.stringify(obj));\n"
        )
        result = js_parser.parse(code, "lib/response.js")
        by_name = {s.name: s for s in result.symbols if s.kind == "method"}
        assert by_name["send"].class_name == "res"
        assert by_name["json"].class_name == "res"
        # The receiver's methods ARE the module API — exported.
        assert "send" in result.exports
        assert "json" in result.exports

    def test_prototype_assignment_owned_by_class(self, js_parser: TypeScriptParser) -> None:
        code = "function Router() {}\nRouter.prototype.handle = function handle(req) {};\n"
        result = js_parser.parse(code, "lib/router.js")
        methods = {s.name: s for s in result.symbols if s.kind == "method"}
        assert methods["handle"].class_name == "Router"

    def test_deep_and_this_receivers_skipped(self, js_parser: TypeScriptParser) -> None:
        code = (
            "a.b.c = function nested() {};\n"
            "this.x = function viaThis() {};\n"
        )
        result = js_parser.parse(code, "lib/misc.js")
        names = {s.name for s in result.symbols}
        assert "nested" not in names
        assert "viaThis" not in names

    def test_non_function_property_assignment_ignored(self, js_parser: TypeScriptParser) -> None:
        code = "config.port = 8080;\nconfig.name = 'svc';\n"
        result = js_parser.parse(code, "lib/config.js")
        assert result.symbols == []
        assert result.exports == []


def test_alias_assignment_counts_as_usage(js_parser: TypeScriptParser) -> None:
    """Dogfood cycle-4 (lodash): `lodash.debounce = debounce` aliases a function by
    name onto the export object — that IS usage of `debounce`."""
    code = "function debounce(fn, wait) {}\nlodash.debounce = debounce;\n"
    result = js_parser.parse(code, "lodash.js")
    assert any(c.name == "debounce" for c in result.calls)


def test_ternary_and_initializer_value_references(js_parser: TypeScriptParser) -> None:
    """Dogfood cycle-4 (lodash): dispatch-table internals referenced by VALUE."""
    code = (
        "function arrayAggregator(a) {}\nfunction baseAggregator(a) {}\n"
        "var func = isArray(c) ? arrayAggregator : baseAggregator;\n"
        "var alias = arrayAggregator;\n"
    )
    result = js_parser.parse(code, "lodash.js")
    names = [c.name for c in result.calls]
    assert names.count("arrayAggregator") >= 2
    assert "baseAggregator" in names


def test_object_literal_value_references(js_parser: TypeScriptParser) -> None:
    """Handler registries / mixins: `{ 'after': after, onError }` references both."""
    code = (
        "function after() {}\nfunction onError() {}\n"
        "mixin({ 'after': after, onError });\n"
    )
    result = js_parser.parse(code, "lib/registry.js")
    names = {c.name for c in result.calls}
    assert "after" in names
    assert "onError" in names
