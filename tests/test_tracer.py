"""
Tier 1 and Tier 2 Unit and Boundary Tests for Python Tracing Engine (tracer.py).

Verifies sys.settrace step capture, call/line/return/exception events,
stack frame inspection, variable extraction, stdout synchronization,
recursion, step limits, and singly-linked list swapPairs acceptance.
"""

import os
import sys
import tempfile
import threading
import time
from pathlib import Path
import pytest

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.tracer import trace_code, execute_trace_sandboxed
from backend.sandbox import StepLimitExceeded, SecurityError


class TestTracerTier1Unit:
    """Tier 1: Core tracing functionality, events, scoping, and stdout capture."""

    def test_primitive_arithmetic_and_variable_assignment(self):
        """T1.1: Traces sequential primitive assignments and arithmetic."""
        code = (
            "a = 1\n"
            "b = 2\n"
            "c = a + b\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        assert res["error"] is None
        assert res["total_steps"] >= 3

        # Final step should have variables a, b, c in active stack frame
        final_step = res["steps"][-1]
        active_frame = [f for f in final_step["stack"] if f["is_active"]][0]
        vars_dict = active_frame["variables"]

        assert vars_dict["a"]["kind"] == "primitive"
        assert vars_dict["a"]["value"] == 1
        assert vars_dict["b"]["kind"] == "primitive"
        assert vars_dict["b"]["value"] == 2
        assert vars_dict["c"]["kind"] == "primitive"
        assert vars_dict["c"]["value"] == 3

    def test_function_call_and_return_events(self):
        """T1.2: Records call, line, and return events with return values."""
        code = (
            "def add(x, y):\n"
            "    return x + y\n"
            "ans = add(3, 4)\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        events = [s["event"] for s in res["steps"]]
        assert "call" in events
        assert "line" in events
        assert "return" in events

        # Inspect the return step inside add
        return_steps = [s for s in res["steps"] if s["event"] == "return" and s["func_name"] == "add"]
        assert len(return_steps) >= 1
        ret_step = return_steps[0]
        active_frame = [f for f in ret_step["stack"] if f["is_active"]][0]
        assert active_frame["func_name"] == "add"
        assert active_frame["return_value"] is not None
        assert active_frame["return_value"]["kind"] == "primitive"
        assert active_frame["return_value"]["value"] == 7

    def test_nested_function_call_stack_depth(self):
        """T1.3: Verifies call stack grows and unwinds across nested calls."""
        code = (
            "def inner(val):\n"
            "    return val * 2\n"
            "def outer(n):\n"
            "    return inner(n) + 1\n"
            "res = outer(5)\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"

        # Find step inside inner
        inner_steps = [s for s in res["steps"] if s["func_name"] == "inner" and s["event"] == "line"]
        assert len(inner_steps) >= 1
        inner_step = inner_steps[0]

        # Stack depth should be 3: <module>, outer, inner
        assert len(inner_step["stack"]) == 3
        assert inner_step["stack"][0]["func_name"] == "<module>"
        assert inner_step["stack"][1]["func_name"] == "outer"
        assert inner_step["stack"][2]["func_name"] == "inner"
        assert inner_step["stack"][2]["is_active"] is True
        assert inner_step["stack"][1]["is_active"] is False

    def test_stdout_capture_across_multiple_prints(self):
        """T1.4: Stdout accumulates accurately across sequential print statements."""
        code = (
            "print('Hello')\n"
            "x = 42\n"
            "print('World')\n"
            "print(f'Number: {x}')\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"

        # Check stdout progress across steps
        stdouts = [s["stdout"] for s in res["steps"]]
        assert any("Hello\n" in out for out in stdouts)
        assert any("Hello\nWorld\n" in out for out in stdouts)
        assert res["steps"][-1]["stdout"] == "Hello\nWorld\nNumber: 42\n"

    def test_variable_reassignment_and_scope_isolation(self):
        """T1.5: Verifies local scope does not overwrite outer/global scope."""
        code = (
            "x = 100\n"
            "def mutate_local():\n"
            "    x = 200\n"
            "    return x\n"
            "y = mutate_local()\n"
            "z = x\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"

        final_step = res["steps"][-1]
        mod_frame = final_step["stack"][0]
        # Outer x must remain 100, y must be 200, z must be 100
        assert mod_frame["variables"]["x"]["value"] == 100
        assert mod_frame["variables"]["y"]["value"] == 200
        assert mod_frame["variables"]["z"]["value"] == 100


class TestTracerTier2Boundary:
    """Tier 2: Edge cases, recursion depth, step limits, runtime exceptions, acceptance."""

    def test_recursive_factorial_stack_frames(self):
        """T2.1: Traces recursive function call stack expansion and return values."""
        code = (
            "def factorial(n):\n"
            "    if n <= 1:\n"
            "        return 1\n"
            "    return n * factorial(n - 1)\n"
            "result = factorial(3)\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"

        # Find maximum stack depth: <module>, factorial(3), factorial(2), factorial(1) = 4
        max_depth = max(len(s["stack"]) for s in res["steps"])
        assert max_depth == 4

        # Verify final return value
        final_step = res["steps"][-1]
        assert final_step["stack"][0]["variables"]["result"]["value"] == 6

    def test_empty_and_comments_only_code(self):
        """T2.2: Handles empty code and comments without crashing."""
        for empty_code in ["", "   \n\n  ", "# Just a comment\n# Another comment\n"]:
            res = trace_code(empty_code)
            assert res["status"] == "ok"
            assert isinstance(res["steps"], list)
            assert res["error"] is None

    def test_runtime_exception_handling(self):
        """T2.3: Gracefully handles runtime exceptions (e.g. ZeroDivisionError)."""
        code = (
            "def divide(a, b):\n"
            "    return a / b\n"
            "res = divide(10, 0)\n"
        )
        res = trace_code(code)
        assert res["status"] == "error"
        assert res["error"]["type"] == "ZeroDivisionError"
        assert "division by zero" in res["error"]["message"].lower()
        assert res["error"]["line"] == 2

    def test_syntax_error_reported_cleanly(self):
        """T2.4: Code with syntax error returns 400-compatible structured error with line."""
        code = (
            "def broken_function(\n"
            "    print('missing paren')\n"
        )
        res = trace_code(code)
        assert res["status"] == "error"
        assert res["error"]["type"] == "SyntaxError"
        assert res["error"]["line"] is not None

    def test_step_limit_enforcement(self):
        """T2.5: Enforces step limit on infinite loops."""
        code = (
            "i = 0\n"
            "while True:\n"
            "    i += 1\n"
        )
        # Run with max_steps=50
        res = trace_code(code, max_steps=50)
        assert res["status"] == "error"
        assert "Step limit" in res["error"]["message"] or "step" in res["error"]["message"].lower()

    def test_step_limit_unbypassable_by_user_try_except(self):
        """T2.6: User code with 'except Exception:' CANNOT catch StepLimitExceeded."""
        code = (
            "while True:\n"
            "    try:\n"
            "        x = 1\n"
            "    except Exception:\n"
            "        pass\n"
        )
        res = trace_code(code, max_steps=30)
        assert res["status"] == "error"
        assert "Step limit" in res["error"]["message"] or "step" in res["error"]["message"].lower()

    def test_exact_1000_vs_1001_step_limit_boundary(self):
        """T2.11: Stepping limits boundary: exactly 1000 steps succeeds, 1001 steps raises StepLimitExceeded."""
        # code_1000 generates exactly 1000 execution steps:
        # Step 0: y = 1
        # Step 1: x = 0
        # Step 2: for i in range(498): (initial loop evaluation)
        # Steps 3..998: 498 iterations of (x += 1, for loop header)
        # Step 999: for loop exhaustion exit
        code_1000 = (
            "y = 1\n"
            "x = 0\n"
            "for i in range(498):\n"
            "    x += 1\n"
        )

        # 1. Exactly 1000 steps with max_steps=1000 MUST SUCCEED
        res_1000 = trace_code(code_1000, max_steps=1000)
        assert res_1000["status"] == "ok"
        assert res_1000["total_steps"] == 1000
        assert len(res_1000["steps"]) == 1000
        assert res_1000["steps"][0]["step"] == 0
        assert res_1000["steps"][-1]["step"] == 999
        assert res_1000["error"] is None

        # 2. Exactly 1001 steps with max_steps=1000 MUST FAIL
        # Prepending 'z = 0' adds exactly 1 execution step, making total steps 1001
        code_1001 = (
            "z = 0\n"
            "y = 1\n"
            "x = 0\n"
            "for i in range(498):\n"
            "    x += 1\n"
        )
        res_1001 = trace_code(code_1001, max_steps=1000)
        assert res_1001["status"] == "error"
        assert res_1001["error"]["type"] == "RuntimeError"
        assert "Step limit of 1000 exceeded." in res_1001["error"]["message"]
        assert "StepLimitExceeded" in res_1001["error"]["traceback"]

        # 3. Off-by-one lower bound check: running code_1000 with max_steps=999 MUST FAIL
        res_999 = trace_code(code_1000, max_steps=999)
        assert res_999["status"] == "error"
        assert res_999["error"]["type"] == "RuntimeError"
        assert "Step limit of 999 exceeded." in res_999["error"]["message"]

    def test_singly_linked_list_swap_pairs_acceptance(self):
        """T2.7: Full swapPairs algorithm tracing per ORIGINAL_REQUEST."""
        code = (
            "class ListNode:\n"
            "    def __init__(self, val=0, next=None):\n"
            "        self.val = val\n"
            "        self.next = next\n"
            "\n"
            "class Solution:\n"
            "    def swapPairs(self, head):\n"
            "        dummy = ListNode(0, head)\n"
            "        prev = dummy\n"
            "        curr = head\n"
            "        while curr and curr.next:\n"
            "            npxt = curr.next.next\n"
            "            second = curr.next\n"
            "            second.next = curr\n"
            "            curr.next = npxt\n"
            "            prev.next = second\n"
            "            prev = curr\n"
            "            curr = npxt\n"
            "        return dummy.next\n"
            "\n"
            "node2 = ListNode(2)\n"
            "node1 = ListNode(1, node2)\n"
            "sol = Solution()\n"
            "res = sol.swapPairs(node1)\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        assert res["total_steps"] > 10

        # Verify ListNode instances exist in heap of final step (node1 and node2)
        final_heap = res["steps"][-1]["heap"]
        list_nodes = [obj for obj in final_heap.values() if obj.get("class_name") == "ListNode"]
        assert len(list_nodes) >= 2  # node1, node2

        # Verify dummy existed during swapPairs function execution
        swap_steps = [s for s in res["steps"] if s["func_name"] == "swapPairs"]
        assert len(swap_steps) > 0
        swap_heap_nodes = [obj for s in swap_steps for obj in s["heap"].values() if obj.get("class_name") == "ListNode"]
        assert any(obj["attrs"]["val"]["value"] == 0 for obj in swap_heap_nodes)

        # Swapped order: res points to node2, node2.next points to node1, node1.next is None
        res_ref = res["steps"][-1]["stack"][0]["variables"]["res"]
        assert res_ref["kind"] == "ref"
        node2_obj = final_heap[res_ref["target"]]
        assert node2_obj["attrs"]["val"]["value"] == 2

        node1_target_id = node2_obj["attrs"]["next"]["target"]
        node1_obj = final_heap[node1_target_id]
        assert node1_obj["attrs"]["val"]["value"] == 1
        assert node1_obj["attrs"]["next"]["value"] is None


class TestTracerRemediationIteration2:
    """Iteration 2 Remediation: Subprocess runner external cwd, thread-safe stdout redirection."""

    def test_execute_trace_sandboxed_from_external_directory(self):
        """Verifies execute_trace_sandboxed works properly when cwd is external (e.g. /tmp)."""
        orig_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp_dir:
            try:
                os.chdir(tmp_dir)
                code = "x = 42\nprint('from external cwd:', x)"
                res = execute_trace_sandboxed(code)
                assert res["status"] == "ok", f"execute_trace_sandboxed failed: {res}"
                assert res["total_steps"] > 0
                assert res["error"] is None
                assert "from external cwd: 42" in res["steps"][-1]["stdout"]
            finally:
                os.chdir(orig_cwd)

    def test_concurrent_trace_execution_stdout_thread_safety(self):
        """Verifies concurrent threads executing trace_code do not corrupt sys.stdout or cross-talk."""
        orig_stdout = sys.stdout
        thread_count = 8
        results = [None] * thread_count
        exceptions = [None] * thread_count

        def worker(thread_idx: int):
            try:
                code = (
                    f"val = {thread_idx}\n"
                    f"for _ in range(5):\n"
                    f"    print('THREAD_{thread_idx}_MARK')\n"
                )
                res = trace_code(code)
                results[thread_idx] = res
            except Exception as e:
                exceptions[thread_idx] = e

        threads = [
            threading.Thread(target=worker, args=(i,))
            for i in range(thread_count)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        for i in range(thread_count):
            assert exceptions[i] is None, f"Thread {i} threw exception: {exceptions[i]}"
            res = results[i]
            assert res is not None
            assert res["status"] == "ok"
            final_stdout = res["steps"][-1]["stdout"]
            # Must contain this thread's output
            assert f"THREAD_{i}_MARK" in final_stdout
            # Must NOT contain other threads' output
            for other in range(thread_count):
                if other != i:
                    assert f"THREAD_{other}_MARK" not in final_stdout

        # Verify sys.stdout was not replaced or corrupted
        assert sys.stdout is orig_stdout

    def test_interleaved_concurrent_trace_preserves_real_stdout(self):
        """Verifies overlapping concurrent executions with delayed start preserve sys.stdout intact."""
        real_stdout = sys.stdout

        def run_thread_1():
            trace_code("for i in range(100):\n    x = sum(range(1000))\n    print(i)")

        def run_thread_2():
            trace_code("for i in range(5):\n    print('T2:', i)")

        t1 = threading.Thread(target=run_thread_1)
        t1.start()
        time.sleep(0.02)
        t2 = threading.Thread(target=run_thread_2)
        t2.start()

        t1.join()
        t2.join()

        assert sys.stdout is real_stdout
