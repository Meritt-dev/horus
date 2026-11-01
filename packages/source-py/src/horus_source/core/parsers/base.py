"""Base parser interface and shared data structures.

Defines the intermediate representation produced by language-specific parsers
before the data is mapped into the knowledge graph.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class SymbolInfo:
    """A parsed symbol (function, class, method, etc.)."""

    name: str
    kind: str  # "function", "class", "method", "interface", "type_alias", "enum"
    start_line: int
    end_line: int
    content: str
    signature: str = ""
    class_name: str = ""  # for methods: the owning class
    decorators: list[str] = field(default_factory=list)  # e.g. ["staticmethod", "server.list_tools"]
    # String-literal arguments passed to decorators, flattened across all decorators on the
    # symbol — e.g. ["MANAGE_SALES"] for @Processor('MANAGE_SALES'), ["/orders"] for @Get('/orders').
    # These are the queue / route / job / message-pattern names that wire a runtime signal to
    # this handler symbol. No-arg decorators (@Injectable) contribute nothing.
    decorator_args: list[str] = field(default_factory=list)
    # Dependency-injection field map for CLASS symbols: {field_name: TypeName}.
    # Populated from constructor parameter-properties / typed field declarations
    # (TS/NestJS) or ``self.x = param`` assignments where ``param`` has a type
    # hint (Python). e.g. {"prismaService": "PrismaService"} for
    # ``constructor(private prismaService: PrismaService)``. Lets call resolution
    # rewrite ``this.prismaService.findOne()`` to the concrete injected service.
    di_fields: dict[str, str] = field(default_factory=dict)
    # True when the symbol NAME was synthesized by the parser rather than read
    # verbatim from a declaration — anonymous/default product exports such as
    # ``module.exports = function () {}`` (named from the file stem) or
    # ``module.exports = class Application {}`` (named from the class expression).
    # Carried onto the graph node's ``properties_json`` as ``synthesized_name``
    # so the engine resolver can prefer a real product default-export over a
    # same-named test/helper. See ``parser_phase`` serialization.
    synthesized_name: bool = False

@dataclass
class ImportInfo:
    """A parsed import statement.

    Contract:
    - ``module``: the source module path (e.g. ``"os.path"``, ``"./utils"``).
    - ``names``: the symbols being imported from *module* (e.g. ``["join", "exists"]``).
      For ``import numpy as np``, ``names=["numpy"]`` (the last segment of the module),
      NOT the alias.  For ``from os.path import join``, ``names=["join"]``.
    - ``alias``: the local binding name when the import is aliased
      (e.g. ``"np"`` for ``import numpy as np``, ``""`` otherwise).
      Import resolution uses ``module`` to locate the target file; ``alias`` is
      only relevant for local-name lookups by callers.
    """

    module: str  # the module path (e.g., "os.path", "./utils")
    names: list[str] = field(default_factory=list)  # imported names (e.g., ["join", "exists"])
    is_relative: bool = False
    alias: str = ""  # local binding name when aliased (e.g. "np" for "import numpy as np")

@dataclass
class CallInfo:
    """A parsed function call."""

    name: str  # the called function/method name
    line: int
    receiver: str = ""  # for method calls: the object (e.g., "self", "user")
    arguments: list[str] = field(default_factory=list)  # bare identifier arguments (callbacks)

@dataclass
class TypeRef:
    """A parsed type annotation reference."""

    name: str  # the type name (e.g., "User", "list", "str")
    kind: str  # "param", "return", "variable"
    line: int
    param_name: str = ""  # for param types: the parameter name

@dataclass(frozen=True)
class ReexportAlias:
    """A cross-module re-export-with-rename — ``export { X as Y } from './mod'``.

    ``public_name`` is the exposed export name (``Y``); ``impl_name`` is the
    differently-named implementation symbol (``X``) defined in ``module``; and
    ``line`` is the 1-based line of the re-export statement in the RE-EXPORTING
    file. Unlike :attr:`ParseResult.export_aliases` (same-file renames), the impl
    lives in another module, so cross-file resolution — and thus the module
    specifier plus an honest re-export line — is required to synthesize the stub.
    """

    public_name: str
    impl_name: str
    module: str
    line: int

@dataclass
class ParseResult:
    """Complete parse result for a single file."""

    symbols: list[SymbolInfo] = field(default_factory=list)
    imports: list[ImportInfo] = field(default_factory=list)
    calls: list[CallInfo] = field(default_factory=list)
    type_refs: list[TypeRef] = field(default_factory=list)
    heritage: list[tuple[str, str, str]] = field(
        default_factory=list
    )  # (class_name, kind, parent_name) where kind is "extends" or "implements"
    exports: list[str] = field(default_factory=list)  # names from __all__ or export statements
    # Export-alias pairs ``(public_name, impl_name)`` — a public export name that
    # is an alias for a differently-named implementation symbol in the SAME file.
    # ``export { BaseComponent as Component }`` -> ``("Component", "BaseComponent")``;
    # ``module.exports = { sign: signImpl }`` -> ``("sign", "signImpl")``.
    # ``parser_phase`` turns each pair into an ``EXPORTS_ALIAS`` edge (public -> impl)
    # so a search on the public name resolves to the real implementation.
    export_aliases: list[tuple[str, str]] = field(default_factory=list)
    # Cross-module re-export-with-rename aliases — ``export { X as Y } from './mod'``.
    # These carry the module specifier and an honest re-export line so a POST-import
    # ingestion phase can resolve the impl (``X``) in another file and synthesize a
    # searchable stub named ``Y`` in THIS file. Same-file renames stay in
    # ``export_aliases``; only the ``from``-clause rename case lands here.
    reexport_aliases: list[ReexportAlias] = field(default_factory=list)

class LanguageParser(ABC):
    """Base interface for language-specific parsers."""

    @abstractmethod
    def parse(self, content: str, file_path: str) -> ParseResult: ...
