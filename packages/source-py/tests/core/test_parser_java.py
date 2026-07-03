from __future__ import annotations

import pytest

from horus_source.core.parsers.java_lang import JavaParser


@pytest.fixture
def java_parser() -> JavaParser:
    return JavaParser()


SPRING = """\
package com.example.api;

import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import java.util.List;

@RestController
@RequestMapping("/users")
public class UserController extends BaseController implements Auditable {
    private final UserService service;

    public UserController(UserService service) {
        this.service = service;
    }

    @GetMapping("/{id}")
    public User getUser(String id) {
        return service.find(id);
    }
}
"""


def test_class_with_annotations_and_heritage(java_parser: JavaParser) -> None:
    result = java_parser.parse(SPRING, "UserController.java")
    classes = {s.name: s for s in result.symbols if s.kind == "class"}
    assert "UserController" in classes
    cls = classes["UserController"]
    # Annotations surface as decorators (+ string-literal args) for entrypoint detection.
    assert "RestController" in cls.decorators
    assert "RequestMapping" in cls.decorators
    assert "/users" in cls.decorator_args
    # Heritage is explicit (extends + implements).
    assert ("UserController", "extends", "BaseController") in result.heritage
    assert ("UserController", "implements", "Auditable") in result.heritage


def test_methods_owned_by_class_with_annotations(java_parser: JavaParser) -> None:
    result = java_parser.parse(SPRING, "UserController.java")
    methods = {s.name: s for s in result.symbols if s.kind == "method"}
    # Both the method and the constructor are captured, owned by the class.
    assert methods["getUser"].class_name == "UserController"
    assert methods["UserController"].class_name == "UserController"  # constructor
    # @GetMapping("/{id}") rides on the method.
    assert "GetMapping" in methods["getUser"].decorators
    assert "/{id}" in methods["getUser"].decorator_args


def test_interface_enum_record(java_parser: JavaParser) -> None:
    code = """\
package m;
interface Auditable { void audit(); }
enum Role { ADMIN, USER }
record Point(int x, int y) {}
"""
    result = java_parser.parse(code, "m.java")
    by_name = {s.name: s.kind for s in result.symbols}
    assert by_name["Auditable"] == "interface"
    assert by_name["Role"] == "enum"
    assert by_name["Point"] == "class"  # record → class-equivalent
    # Interface method is owned by the interface.
    audit = next(s for s in result.symbols if s.name == "audit")
    assert audit.kind == "method" and audit.class_name == "Auditable"


def test_imports(java_parser: JavaParser) -> None:
    code = """\
package m;
import java.util.List;
import static org.junit.Assert.assertEquals;
import com.example.*;
"""
    result = java_parser.parse(code, "m.java")
    modules = {imp.module: imp for imp in result.imports}
    assert "java.util.List" in modules
    assert modules["java.util.List"].names == ["List"]
    assert "org.junit.Assert.assertEquals" in modules  # static import, `static` stripped
    assert "com.example.*" in modules


def test_calls_with_receiver(java_parser: JavaParser) -> None:
    code = """\
package m;
class A {
    void run() {
        service.find(id);
        helper();
    }
}
"""
    result = java_parser.parse(code, "A.java")
    calls = {(c.name, c.receiver) for c in result.calls}
    assert ("find", "service") in calls
    assert ("helper", "") in calls


def test_extends_interface_heritage(java_parser: JavaParser) -> None:
    # An interface extending another interface → implements-style heritage edge.
    code = """\
package m;
interface Repo extends Crud, Searchable {}
"""
    result = java_parser.parse(code, "Repo.java")
    parents = {(c, k, p) for (c, k, p) in result.heritage}
    assert ("Repo", "implements", "Crud") in parents
    assert ("Repo", "implements", "Searchable") in parents


def test_realistic_spring_service_endtoend(java_parser: JavaParser) -> None:
    code = """\
package com.shop.order;

import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;

@Service
public class OrderService {
    @Autowired
    private OrderRepository repo;

    public Order place(Order order) {
        repo.save(order);
        return order;
    }
}
"""
    result = java_parser.parse(code, "OrderService.java")
    svc = next(s for s in result.symbols if s.name == "OrderService")
    assert svc.kind == "class"
    assert "Service" in svc.decorators
    place = next(s for s in result.symbols if s.name == "place")
    assert place.kind == "method" and place.class_name == "OrderService"
    assert any(c.name == "save" and c.receiver == "repo" for c in result.calls)
    assert any(i.module == "org.springframework.stereotype.Service" for i in result.imports)


def test_public_symbols_are_exported_private_are_not(java_parser: JavaParser) -> None:
    """HS-6: public/protected declarations become exports so dead-code exempts
    them (an uncalled public method is API, not dead). Private ones do not."""
    code = """\
package m;
public class Service {
    public void publicApi() {}
    protected void protectedApi() {}
    private void privateHelper() {}
}
class PackagePrivate {}
"""
    result = java_parser.parse(code, "Service.java")
    exports = set(result.exports)
    assert "Service" in exports          # public class
    assert "publicApi" in exports        # public method
    assert "protectedApi" in exports     # protected method (extensible API)
    assert "privateHelper" not in exports
    assert "PackagePrivate" not in exports  # package-private class


def test_interface_members_are_implicitly_public_exports(java_parser: JavaParser) -> None:
    """Interface methods carry no modifier keyword but ARE the public contract —
    they must be exported so dead-code never flags them (caught live on gson:
    JsonDeserializationContext#deserialize was marked dead)."""
    code = """\
package m;
public interface Codec {
    String encode(Object value);
    void decode(String raw);
}
"""
    result = java_parser.parse(code, "Codec.java")
    exports = set(result.exports)
    assert "encode" in exports
    assert "decode" in exports
