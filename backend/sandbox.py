"""Security sandbox for untrusted Python code execution.

Implements a 4-tier defense architecture:
1. Static AST validation (forbidden imports, dangerous dunders, forbidden builtins).
2. Sanitized runtime __builtins__ dictionary with safe import hook.
3. Step limit guard via StepLimitExceeded(BaseException).
4. Wall-clock execution timeout watchdog.
"""

import ast
import builtins
from typing import Any, Dict, Set

from .limits import TIMEOUT_SECONDS

class SecurityError(Exception):
    """Raised when code violates sandboxing security constraints."""

    def __init__(self, message: str, lineno: int | None = None):
        super().__init__(message)
        self.message = message
        self.lineno = lineno

    def __str__(self) -> str:
        if self.lineno is not None:
            return f"Line {self.lineno}: {self.message}"
        return self.message


class StepLimitExceeded(BaseException):
    """Raised when execution step count exceeds MAX_STEPS.

    Inherits from BaseException so standard 'except Exception:'
    blocks in user code cannot catch or suppress it.
    """
    pass


# Whitelist of standard library modules permitted for import
ALLOWED_MODULES: Set[str] = {
    "math",
    "collections",
    "heapq",
    "bisect",
    "itertools",
    "functools",
    "typing",
    "random",
    "re",
    "json",
    "copy",
    "string",
}

# Forbidden modules and dangerous re-exported module names
FORBIDDEN_MODULES: Set[str] = {
    "sys",
    "os",
    "subprocess",
    "codecs",
    "shutil",
    "socket",
    "importlib",
    "posix",
    "nt",
    "pty",
    "ctypes",
    "inspect",
    "threading",
    "multiprocessing",
    "signal",
    "_os",
    "_sys",
}

# Dangerous dunder and reflection attributes that could allow sandbox escapes
FORBIDDEN_ATTRIBUTES: Set[str] = {
    "__subclasses__",
    "__globals__",
    "__code__",
    "__builtins__",
    "__bases__",
    "__base__",
    "__dict__",
    "__setattr__",
    "__delattr__",
    "__getattribute__",
    "__mro__",
    "__class__",
    "__traceback__",
    "tb_frame",
    "tb_next",
    "f_back",
    "f_globals",
    "f_builtins",
    "f_code",
    "f_locals",
    "cr_frame",
    "cr_code",
    "gi_frame",
    "gi_code",
    "ag_frame",
    "ag_code",
    "__closure__",
    "__func__",
    "__self__",
    "__module__",
}

# Explicit safe dunder methods permitted for custom classes and standard operator overloading
ALLOWED_DUNDER_METHODS: Set[str] = {
    "__init__",
    "__iter__",
    "__next__",
    "__len__",
    "__getitem__",
    "__setitem__",
    "__delitem__",
    "__repr__",
    "__str__",
    "__eq__",
    "__ne__",
    "__lt__",
    "__le__",
    "__gt__",
    "__ge__",
    "__add__",
    "__sub__",
    "__mul__",
    "__truediv__",
    "__floordiv__",
    "__mod__",
    "__pow__",
    "__hash__",
    "__bool__",
    "__contains__",
    "__enter__",
    "__exit__",
}

# Dangerous builtin function names that must not be referenced
FORBIDDEN_CALLS_OR_NAMES: Set[str] = {
    "eval",
    "exec",
    "open",
    "breakpoint",
    "exit",
    "quit",
    "compile",
    "__import__",
    "BaseException",
}

# Safe built-in functions, types, and exceptions to expose in runtime scope
SAFE_BUILTIN_NAMES: Set[str] = {
    # Functions and types
    "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes",
    "callable", "chr", "complex", "delattr", "dict", "dir", "divmod",
    "enumerate", "filter", "float", "format", "frozenset", "getattr",
    "hasattr", "hash", "hex", "id", "int", "isinstance", "issubclass",
    "iter", "len", "list", "map", "max", "min", "next", "object",
    "oct", "ord", "pow", "print", "property", "range", "repr",
    "reversed", "round", "set", "setattr", "slice", "sorted",
    "staticmethod", "classmethod", "str", "sum", "super", "tuple",
    "type", "zip",
    "__build_class__",
    # Constants
    "True", "False", "None", "Ellipsis",
    # Standard exceptions
    "ArithmeticError", "AssertionError", "AttributeError",
    "BufferError", "BytesWarning", "DeprecationWarning", "EOFError",
    "Exception", "FloatingPointError", "FutureWarning", "GeneratorExit",
    "ImportError", "ImportWarning", "IndexError", "KeyError", "LookupError",
    "MemoryError", "NameError", "NotImplemented", "NotImplementedError",
    "OSError", "OverflowError", "RecursionError", "ReferenceError",
    "RuntimeError", "RuntimeWarning", "StopAsyncIteration", "StopIteration",
    "SyntaxError", "SyntaxWarning", "SystemError", "TabError", "TypeError",
    "UnboundLocalError", "UnicodeDecodeError", "UnicodeEncodeError",
    "UnicodeError", "UnicodeTranslateError", "UnicodeWarning", "UserWarning",
    "ValueError", "Warning", "ZeroDivisionError",
}


class ASTSecurityValidator(ast.NodeVisitor):
    """AST visitor that checks for forbidden imports, attributes, and calls."""

    def __init__(self) -> None:
        super().__init__()
        self.imported_modules: Set[str] = set()

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root_name = alias.name.split(".")[0]
            if root_name not in ALLOWED_MODULES or root_name in FORBIDDEN_MODULES:
                raise SecurityError(
                    f"Import of module '{alias.name}' is prohibited.",
                    lineno=node.lineno,
                )
            self.imported_modules.add(alias.asname or root_name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level is not None and node.level > 0:
            raise SecurityError(
                "Relative imports are prohibited.",
                lineno=node.lineno,
            )
        if not node.module:
            raise SecurityError(
                "Empty module import is prohibited.",
                lineno=node.lineno,
            )
        root_name = node.module.split(".")[0]
        if root_name not in ALLOWED_MODULES or root_name in FORBIDDEN_MODULES:
            raise SecurityError(
                f"Import of module '{node.module}' is prohibited.",
                lineno=node.lineno,
            )
        for alias in node.names:
            if (
                alias.name in FORBIDDEN_MODULES
                or alias.name in {"sys", "os", "subprocess", "codecs", "_os", "_sys"}
                or alias.name.startswith("_")
                or alias.name in FORBIDDEN_ATTRIBUTES
                or alias.name in FORBIDDEN_CALLS_OR_NAMES
            ):
                raise SecurityError(
                    f"Importing '{alias.name}' is prohibited.",
                    lineno=node.lineno,
                )
            self.imported_modules.add(alias.asname or alias.name)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in FORBIDDEN_ATTRIBUTES:
            raise SecurityError(
                f"Access to attribute '{node.attr}' is prohibited.",
                lineno=node.lineno,
            )
        if node.attr.startswith("__") and node.attr.endswith("__"):
            if node.attr not in ALLOWED_DUNDER_METHODS:
                raise SecurityError(
                    f"Access to dunder attribute '{node.attr}' is prohibited.",
                    lineno=node.lineno,
                )
        if (
            node.attr in FORBIDDEN_MODULES
            or node.attr in {"sys", "os", "subprocess", "codecs", "_os", "_sys"}
        ):
            raise SecurityError(
                f"Access to module attribute '{node.attr}' is prohibited.",
                lineno=node.lineno,
            )
        if (
            isinstance(node.value, ast.Name)
            and node.value.id in self.imported_modules
            and node.attr.startswith("_")
        ):
            raise SecurityError(
                f"Access to private attribute '{node.attr}' on imported module '{node.value.id}' is prohibited.",
                lineno=node.lineno,
            )
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in FORBIDDEN_CALLS_OR_NAMES:
            raise SecurityError(
                f"Use of '{node.id}' is prohibited.",
                lineno=node.lineno,
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        func_name = None
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        if func_name in {"getattr", "hasattr", "setattr", "delattr", "__getattribute__"}:
            if len(node.args) >= 2:
                arg1 = node.args[1]
                if not isinstance(arg1, ast.Constant) or not isinstance(arg1.value, str):
                    raise SecurityError(
                        f"Dynamic attribute name in '{func_name}' is prohibited.",
                        lineno=node.lineno,
                    )
                attr_name = arg1.value
                if (
                    attr_name in FORBIDDEN_ATTRIBUTES
                    or attr_name in FORBIDDEN_MODULES
                    or attr_name in {"sys", "os", "subprocess", "codecs", "_os", "_sys"}
                    or (attr_name.startswith("__") and attr_name.endswith("__") and attr_name not in ALLOWED_DUNDER_METHODS)
                    or attr_name.startswith("__")
                ):
                    raise SecurityError(
                        f"Access to attribute '{attr_name}' is prohibited.",
                        lineno=node.lineno,
                    )
        self.generic_visit(node)

    def _check_try_handlers(self, handlers: list) -> None:
        for handler in handlers:
            if handler.type is None:
                raise SecurityError(
                    "Bare 'except:' is prohibited. Catch specific Exception subclasses instead.",
                    lineno=handler.lineno,
                )
            for subnode in ast.walk(handler.type):
                if isinstance(subnode, ast.Name) and subnode.id == "BaseException":
                    raise SecurityError(
                        "Catching 'BaseException' is prohibited. Catch specific Exception subclasses instead.",
                        lineno=handler.lineno,
                    )

    def visit_Try(self, node: ast.Try) -> None:
        self._check_try_handlers(node.handlers)
        self.generic_visit(node)

    def visit_TryStar(self, node: Any) -> None:
        self._check_try_handlers(node.handlers)
        self.generic_visit(node)


def validate_ast(code: str) -> ast.AST:
    """Parses code and performs static security checks.

    Raises SyntaxError if parsing fails.
    Raises SecurityError if a forbidden construct is detected.
    """
    tree = ast.parse(code, filename="<user_code>")
    validator = ASTSecurityValidator()
    validator.visit(tree)
    return tree


def safe_import(name: str, globals: Dict[str, Any] | None = None,
                locals: Dict[str, Any] | None = None,
                fromlist: tuple = (), level: int = 0) -> Any:
    """Restricted import hook permitting only whitelisted modules."""
    if level > 0:
        raise SecurityError(f"Relative imports are prohibited: {name}")
    root_name = name.split(".")[0]
    if root_name not in ALLOWED_MODULES or root_name in FORBIDDEN_MODULES:
        raise SecurityError(f"Import of module '{name}' is prohibited")
    if fromlist:
        for item in fromlist:
            if (
                item in FORBIDDEN_MODULES
                or item in {"sys", "os", "subprocess", "codecs", "_os", "_sys"}
                or item.startswith("_")
                or item in FORBIDDEN_ATTRIBUTES
                or item in FORBIDDEN_CALLS_OR_NAMES
            ):
                raise SecurityError(f"Importing '{item}' from '{name}' is prohibited.")
    return __import__(name, globals, locals, fromlist, level)


def _is_forbidden_attr(name: str) -> bool:
    if not isinstance(name, str):
        return True
    if (
        name in FORBIDDEN_ATTRIBUTES
        or name in FORBIDDEN_MODULES
        or name in {"sys", "os", "subprocess", "codecs", "_os", "_sys"}
    ):
        return True
    if name.startswith("__") and name.endswith("__"):
        return name not in ALLOWED_DUNDER_METHODS
    if name.startswith("__"):
        return True
    return False


def safe_getattr(obj: Any, name: str, *args: Any) -> Any:
    """Restricted getattr prohibiting forbidden or dangerous attributes."""
    if _is_forbidden_attr(name):
        raise SecurityError(f"Access to attribute '{name}' is prohibited.")
    return getattr(obj, name, *args)


def safe_setattr(obj: Any, name: str, value: Any) -> None:
    """Restricted setattr prohibiting forbidden or dangerous attributes."""
    if _is_forbidden_attr(name):
        raise SecurityError(f"Access to attribute '{name}' is prohibited.")
    return setattr(obj, name, value)


def safe_delattr(obj: Any, name: str) -> None:
    """Restricted delattr prohibiting forbidden or dangerous attributes."""
    if _is_forbidden_attr(name):
        raise SecurityError(f"Access to attribute '{name}' is prohibited.")
    return delattr(obj, name)


def safe_hasattr(obj: Any, name: str) -> bool:
    """Restricted hasattr prohibiting forbidden or dangerous attributes."""
    if _is_forbidden_attr(name):
        return False
    return hasattr(obj, name)


def get_safe_builtins() -> Dict[str, Any]:
    """Generates a restricted __builtins__ dictionary."""
    safe = {k: v for k, v in builtins.__dict__.items() if k in SAFE_BUILTIN_NAMES}
    safe["__import__"] = safe_import
    safe["getattr"] = safe_getattr
    safe["hasattr"] = safe_hasattr
    safe["setattr"] = safe_setattr
    safe["delattr"] = safe_delattr
    return safe
