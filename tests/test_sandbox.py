"""
Tier 1 and Tier 2 Unit and Boundary Tests for AST Validation and Sandbox Guards (sandbox.py).

Tests:
- Normal safe code executes without restriction.
- AST blocking of forbidden modules (os, sys, subprocess, socket, shutil).
- AST blocking of dangerous dunder attributes (__subclasses__, __globals__, __code__, etc.).
- Restricted builtins (eval, exec, open, breakpoint, exit, quit).
- Whitelist imports permitted (math, collections, heapq, itertools, functools, random, re, json).
- Relative imports blocked.
- StepLimitExceeded(BaseException) cannot be suppressed by 'except Exception:'.
- Execution timeout watchdog terminates infinite loops.
"""

import sys
import time
from pathlib import Path
import pytest

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.sandbox import (
    ALLOWED_MODULES,
    ASTSecurityValidator,
    FORBIDDEN_ATTRIBUTES,
    SecurityError,
    StepLimitExceeded,
    get_safe_builtins,
    safe_delattr,
    safe_getattr,
    safe_hasattr,
    safe_import,
    safe_setattr,
    validate_ast,
)
from backend.tracer import trace_code


class TestSandboxTier1Unit:
    """Tier 1: AST validation, forbidden modules, dangerous builtins, whitelist."""

    def test_safe_standard_code_validates_without_error(self):
        """T1.11: Normal algorithm code passes AST validation without security errors."""
        safe_code = (
            "def binary_search(arr, target):\n"
            "    left, right = 0, len(arr) - 1\n"
            "    while left <= right:\n"
            "        mid = (left + right) // 2\n"
            "        if arr[mid] == target:\n"
            "            return mid\n"
            "        elif arr[mid] < target:\n"
            "            left = mid + 1\n"
            "        else:\n"
            "            right = mid - 1\n"
            "    return -1\n"
            "idx = binary_search([1, 3, 5, 7, 9], 7)\n"
        )
        tree = validate_ast(safe_code)
        assert tree is not None
        res = trace_code(safe_code)
        assert res["status"] == "ok"
        assert res["steps"][-1]["stack"][0]["variables"]["idx"]["value"] == 3

    def test_forbidden_module_imports_blocked_by_ast(self):
        """T1.14: AST validator blocks prohibited standard library modules."""
        forbidden_imports = [
            "import os",
            "import sys",
            "import subprocess",
            "import socket",
            "import shutil",
            "import importlib",
            "import urllib",
            "import pty",
        ]
        for stmt in forbidden_imports:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(stmt)
            assert "prohibited" in str(exc_info.value).lower()

            # Also check through trace_code
            res = trace_code(stmt)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_from_import_forbidden_modules_blocked(self):
        """T1.14b: 'from X import Y' syntax for forbidden modules is blocked."""
        forbidden_froms = [
            "from os import system",
            "from subprocess import Popen, run",
            "from sys import modules, exit",
            "from socket import socket",
        ]
        for stmt in forbidden_froms:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(stmt)
            assert "prohibited" in str(exc_info.value).lower()

    def test_restricted_builtin_calls_and_names_blocked(self):
        """T1.15: Calls to dangerous builtins (eval, exec, open, breakpoint) are blocked."""
        dangerous_calls = [
            "open('/etc/passwd', 'r')",
            "eval('1 + 1')",
            "exec('x = 1')",
            "breakpoint()",
            "exit(0)",
            "quit()",
            "__import__('os')",
        ]
        for code_snippet in dangerous_calls:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(code_snippet)
            assert "prohibited" in str(exc_info.value).lower()

            res = trace_code(code_snippet)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_allowed_whitelist_modules(self):
        """Verifies modules in ALLOWED_MODULES can be imported and executed."""
        whitelisted_snippets = [
            "import math\nval = math.sqrt(16)\n",
            "import heapq\nq = []\nheapq.heappush(q, 5)\n",
            "from collections import deque, Counter\nd = deque([1, 2])\n",
            "import itertools\ncomb = list(itertools.combinations([1, 2], 2))\n",
            "import functools\nprod = functools.reduce(lambda x, y: x * y, [2, 3, 4])\n",
            "import json\ns = json.dumps({'a': 1})\n",
            "import re\nm = re.match(r'\\d+', '123')\n",
            "import random\nr = random.randint(1, 10)\n",
        ]
        for snippet in whitelisted_snippets:
            tree = validate_ast(snippet)
            assert tree is not None
            res = trace_code(snippet)
            assert res["status"] == "ok", f"Failed on snippet: {snippet}, error: {res.get('error')}"


class TestSandboxTier2Boundary:
    """Tier 2: Escape dunders, step limits, watchdog timeout, relative imports."""

    def test_forbidden_dunder_attributes_blocked(self):
        """T2.8: Access to dangerous escape dunders is blocked by AST."""
        dunder_attacks = [
            "x = ().__class__.__bases__[0].__subclasses__()",
            "f = lambda: None; g = f.__globals__",
            "c = f.__code__",
            "b = f.__builtins__",
            "m = object.__mro__",
            "cls = (1).__class__",
        ]
        for attack in dunder_attacks:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(attack)
            assert "prohibited" in str(exc_info.value).lower()

            res = trace_code(attack)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_relative_import_blocked(self):
        """T2.9: Relative imports (. or ..) are prohibited."""
        relative_imports = [
            "from . import something",
            "from ..backend import limits",
        ]
        for stmt in relative_imports:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(stmt)
            assert "relative" in str(exc_info.value).lower()

    def test_safe_import_hook_rejection(self):
        """T2.10: safe_import hook rejects non-whitelisted modules at runtime."""
        with pytest.raises(SecurityError) as exc:
            safe_import("os")
        assert "prohibited" in str(exc.value)

        with pytest.raises(SecurityError) as exc:
            safe_import("sys")
        assert "prohibited" in str(exc.value)

        # Allowed module should succeed
        math_mod = safe_import("math")
        assert math_mod is not None
        assert hasattr(math_mod, "sqrt")

    def test_step_limit_exceeded_exception_class(self):
        """T2.11: StepLimitExceeded is a BaseException, not an Exception."""
        assert issubclass(StepLimitExceeded, BaseException)
        assert not issubclass(StepLimitExceeded, Exception)

        # Demonstrate standard except Exception does not catch it
        caught_by_standard_exception = False
        try:
            raise StepLimitExceeded("limit hit")
        except Exception:
            caught_by_standard_exception = True
        except BaseException:
            pass
        assert not caught_by_standard_exception

    def test_execution_timeout_watchdog_on_infinite_loop(self):
        """T1.12: Execution times out cleanly on infinite loops."""
        code = (
            "while True:\n"
            "    pass\n"
        )
        t0 = time.perf_counter()
        # Set short timeout of 0.5s for fast test execution
        res = trace_code(code, timeout=0.5, max_steps=100_000)
        elapsed = time.perf_counter() - t0

        assert res["status"] == "error"
        assert res["error"]["type"] in ("TimeoutError", "RuntimeError")
        assert "timed out" in res["error"]["message"].lower() or "timeout" in res["error"]["message"].lower()
        # Should have stopped within ~2 seconds
        assert elapsed < 3.0


class TestSandboxRemediationIteration2:
    """Iteration 2 Remediation: Traceback frames, dynamic reflection, except BaseException guards."""

    def test_traceback_frame_reflection_attributes_blocked(self):
        """Verifies traceback and frame reflection attributes are blocked in AST and execution."""
        forbidden_snippets = [
            "try:\n    1 / 0\nexcept Exception as e:\n    tb = e.__traceback__\n",
            "try:\n    1 / 0\nexcept Exception as e:\n    frame = e.tb_frame\n",
            "try:\n    1 / 0\nexcept Exception as e:\n    nxt = e.tb_next\n",
            "def f():\n    pass\nglobs = f.f_globals\n",
            "def f():\n    pass\nbuiltins = f.f_builtins\n",
            "def f():\n    pass\ncode = f.f_code\n",
            "def f():\n    pass\nlocals = f.f_locals\n",
            "def f():\n    pass\nclosure = f.__closure__\n",
            "def f():\n    pass\nfunc = f.__func__\n",
            "def f():\n    pass\nself_attr = f.__self__\n",
            "def f():\n    pass\nmod = f.__module__\n",
        ]
        for snippet in forbidden_snippets:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(snippet)
            assert "prohibited" in str(exc_info.value).lower()
            res = trace_code(snippet)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_dynamic_getattr_dunder_traversal_blocked(self):
        """Verifies dynamic getattr subclass traversal exploits raise SecurityError."""
        attack_snippets = [
            "c = getattr((), '__' + 'class__')\n",
            "b = getattr(getattr((), '__' + 'class__'), '__' + 'bases__')[0]\n",
            "subs = getattr(getattr(getattr((), '__' + 'class__'), '__' + 'bases__')[0], '__' + 'subclasses__')()\n",
            "tb = getattr(Exception(), '__' + 'traceback__')\n",
        ]
        for snippet in attack_snippets:
            res = trace_code(snippet)
            assert res["status"] == "error", f"Failed to block: {snippet}"
            assert res["error"]["type"] == "SecurityError"

    def test_static_getattr_setattr_delattr_hasattr_blocked(self):
        """Verifies static calls to reflection functions with dunder or forbidden names are blocked."""
        forbidden_static_calls = [
            "c = getattr((), '__class__')",
            "b = getattr(object, '__bases__')",
            "s = getattr(object, '__subclasses__')",
            "h = hasattr((), '__class__')",
            "setattr(object, '__class__', None)",
            "delattr(object, '__class__')",
            "tb = getattr(Exception(), 'tb_frame')",
        ]
        for call_stmt in forbidden_static_calls:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(call_stmt)
            assert "prohibited" in str(exc_info.value).lower()
            res = trace_code(call_stmt)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_safe_reflection_wrapper_functions(self):
        """Directly verifies safe_getattr, safe_hasattr, safe_setattr, safe_delattr guards."""
        class Dummy:
            def __init__(self):
                self.val = 42

        d = Dummy()

        # Safe attribute accesses should succeed
        assert safe_getattr(d, "val") == 42
        assert safe_hasattr(d, "val") is True
        safe_setattr(d, "val", 99)
        assert d.val == 99
        safe_delattr(d, "val")
        assert not hasattr(d, "val")
        assert safe_hasattr(d, "val") is False

        # Forbidden attributes must be rejected
        for attr in FORBIDDEN_ATTRIBUTES:
            with pytest.raises(SecurityError):
                safe_getattr(d, attr)
            with pytest.raises(SecurityError):
                safe_setattr(d, attr, 1)
            with pytest.raises(SecurityError):
                safe_delattr(d, attr)
            assert safe_hasattr(d, attr) is False

        # Any dunder or non-string must be rejected
        with pytest.raises(SecurityError):
            safe_getattr(d, "__secret__")
        with pytest.raises(SecurityError):
            safe_getattr(d, 123)
        assert safe_hasattr(d, "__secret__") is False
        assert safe_hasattr(d, 123) is False

    def test_full_sandbox_escape_exploit_blocked(self):
        """Verify full Reviewer 2 breakout chain targeting _wrap_close.__globals__ is blocked."""
        exploit = (
            "obj = getattr(getattr((), '__class__'), '__bases__')[0]\n"
            "subs = getattr(obj, '__subclasses__')()\n"
            "wrap = [s for s in subs if 'wrap_close' in s.__name__][0]\n"
            "globs = getattr(getattr(wrap, '__init__'), '__globals__')\n"
            "pwned = 'system' in globs\n"
        )
        res = trace_code(exploit)
        assert res["status"] == "error"
        assert res["error"]["type"] == "SecurityError"
        assert "prohibited" in res["error"]["message"].lower()

    def test_bare_except_prohibited(self):
        """Verifies bare except: is blocked by ASTSecurityValidator."""
        code = "try:\n    x = 1\nexcept:\n    x = 2\n"
        with pytest.raises(SecurityError) as exc_info:
            validate_ast(code)
        assert "bare 'except:' is prohibited" in str(exc_info.value).lower()

        res = trace_code(code)
        assert res["status"] == "error"
        assert res["error"]["type"] == "SecurityError"

    def test_except_base_exception_prohibited(self):
        """Verifies except BaseException: (and tuples containing it) is blocked."""
        snippets = [
            "try:\n    x = 1\nexcept BaseException:\n    x = 2\n",
            "try:\n    x = 1\nexcept (Exception, BaseException):\n    x = 2\n",
            "try:\n    x = 1\nexcept (BaseException,):\n    x = 2\n",
        ]
        for code in snippets:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(code)
            assert "baseexception" in str(exc_info.value).lower()

            res = trace_code(code)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_permitted_except_blocks(self):
        """Verifies legitimate exception handling (e.g. Exception, ValueError) is allowed."""
        code = (
            "try:\n"
            "    val = int('not_a_number')\n"
            "except ValueError as e:\n"
            "    val = -1\n"
            "except (TypeError, KeyError):\n"
            "    val = -2\n"
            "except Exception:\n"
            "    val = -3\n"
        )
        tree = validate_ast(code)
        assert tree is not None
        res = trace_code(code)
        assert res["status"] == "ok"
        final_val = res["steps"][-1]["stack"][0]["variables"]["val"]["value"]
        assert final_val == -1


class TestSandboxRemediationIteration3:
    """Iteration 3 Remediation: Seal reflection escapes, module leaks, and BaseException."""

    def test_object_getattribute_and_reflection_attributes_blocked(self):
        """Verifies object.__getattribute__, type.__dict__, and forbidden attributes raise SecurityError."""
        attack_snippets = [
            "t = object.__getattribute__((), '__class__')",
            "subs = type.__dict__['__subclasses__']",
            "f = object.__setattr__",
            "f = object.__delattr__",
            (
                "try: 1 / 0\n"
                "except Exception as e:\n"
                "    tb = object.__getattribute__(e, '__traceback__')\n"
            ),
            "subclasses_fn = type.__getattribute__(object, '__subclasses__')",
        ]
        for code in attack_snippets:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(code)
            assert "prohibited" in str(exc_info.value).lower()

            res = trace_code(code)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_from_import_reexported_modules_blocked(self):
        """Verifies 'from <module> import <forbidden>' is blocked with SecurityError."""
        leak_imports = [
            "from typing import sys",
            "from collections import _sys",
            "from random import _os",
            "from json import codecs",
            "from string import _string",
        ]
        for code in leak_imports:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(code)
            assert "prohibited" in str(exc_info.value).lower()

            res = trace_code(code)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_whitelisted_module_attribute_access_blocked(self):
        """Verifies accessing forbidden modules or private attributes on imported modules is blocked."""
        module_attacks = [
            "import typing\ns = typing.sys",
            "import random\no = random._os",
            "import collections\ns = collections._sys",
            "import json\nc = json.codecs",
        ]
        for code in module_attacks:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(code)
            assert "prohibited" in str(exc_info.value).lower()

            res = trace_code(code)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

    def test_base_exception_reference_and_aliasing_blocked(self):
        """Verifies referencing BaseException or __base__ is blocked with SecurityError."""
        base_attacks = [
            "B = BaseException",
            "B = Exception.__base__",
            "B = Exception.__bases__",
            "class MyError(BaseException): pass",
            "is_be = issubclass(ValueError, BaseException)",
        ]
        for code in base_attacks:
            with pytest.raises(SecurityError) as exc_info:
                validate_ast(code)
            assert "prohibited" in str(exc_info.value).lower()

            res = trace_code(code)
            assert res["status"] == "error"
            assert res["error"]["type"] == "SecurityError"

        # Also confirm BaseException is stripped from runtime builtins
        builtins_dict = get_safe_builtins()
        assert "BaseException" not in builtins_dict

    def test_allowed_dunder_methods_permitted(self):
        """Verifies safe dunder methods (__init__, __iter__, __len__, __repr__, etc.) are allowed."""
        code = (
            "class Item:\n"
            "    def __init__(self, val):\n"
            "        self.val = val\n"
            "    def __len__(self):\n"
            "        return 1\n"
            "    def __repr__(self):\n"
            "        return f'Item({self.val})'\n"
            "    def __eq__(self, other):\n"
            "        return self.val == other.val\n"
            "\n"
            "it1 = Item(10)\n"
            "it2 = Item(10)\n"
            "is_equal = (it1 == it2)\n"
            "length = len(it1)\n"
        )
        tree = validate_ast(code)
        assert tree is not None
        res = trace_code(code)
        assert res["status"] == "ok"
        final_vars = res["steps"][-1]["stack"][0]["variables"]
        assert final_vars["is_equal"]["value"] is True
        assert final_vars["length"]["value"] == 1

