"""Execution tracer using sys.settrace to capture stack frames, heap, and stdout.

Features:
- Event capture for 'call', 'line', 'return', 'exception'.
- Frame filtering restricted to '<user_code>'.
- Integrated with Serializer for immutable per-step stack & heap snapshots.
- Cumulative stdout capture via io.StringIO redirect.
- 4-tier security sandbox integration (AST check, safe builtins, step limit, timeout).
- Direct function execution API and subprocess CLI runner.
"""

import io
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

from .limits import MAX_OBJECTS, MAX_STEPS, MAX_STRING_LENGTH, TIMEOUT_SECONDS
from .sandbox import (
    SecurityError,
    StepLimitExceeded,
    get_safe_builtins,
    validate_ast,
)
from .serializer import Serializer

_stdout_lock = threading.Lock()


def trace_code(
    code: str,
    max_steps: int = MAX_STEPS,
    timeout: float = TIMEOUT_SECONDS,
    max_objects: int = MAX_OBJECTS,
    max_string_length: int = MAX_STRING_LENGTH,
) -> Dict[str, Any]:
    """Traces Python code execution and returns a structured step-by-step history."""
    # Tier 1: Static AST validation
    try:
        validate_ast(code)
    except SyntaxError as e:
        return {
            "status": "error",
            "error": {
                "type": type(e).__name__,
                "message": e.msg if hasattr(e, "msg") else str(e),
                "line": e.lineno,
                "offset": getattr(e, "offset", None),
                "traceback": traceback.format_exc(),
            },
        }
    except SecurityError as e:
        return {
            "status": "error",
            "error": {
                "type": "SecurityError",
                "message": e.message,
                "line": e.lineno,
                "traceback": traceback.format_exc(),
            },
        }

    # Compile user code
    try:
        code_obj = compile(code, "<user_code>", "exec")
    except SyntaxError as e:
        return {
            "status": "error",
            "error": {
                "type": type(e).__name__,
                "message": e.msg if hasattr(e, "msg") else str(e),
                "line": e.lineno,
                "offset": getattr(e, "offset", None),
                "traceback": traceback.format_exc(),
            },
        }

    # Setup execution environment
    serializer = Serializer(
        max_objects=max_objects,
        max_string_length=max_string_length,
    )
    steps: List[Dict[str, Any]] = []
    stdout_buffer = io.StringIO()
    start_time = time.perf_counter()
    last_lineno: Optional[int] = None

    # Tier 2: Sanitized runtime environment
    safe_builtins = get_safe_builtins()
    exec_globals: Dict[str, Any] = {
        "__builtins__": safe_builtins,
        "__name__": "__main__",
        "__doc__": None,
        "__package__": None,
    }

    def tracer(frame: Any, event: str, arg: Any) -> Any:
        nonlocal last_lineno

        # Only trace frames in user code
        if frame.f_code.co_filename != "<user_code>":
            return None

        # Ignore initial module entry call before line 1 executes
        if frame.f_code.co_name == "<module>" and event == "call":
            return tracer

        last_lineno = frame.f_lineno

        # Tier 3: Step limit guard
        if len(steps) >= max_steps:
            raise StepLimitExceeded(f"Step limit of {max_steps} exceeded.")

        # Tier 4: Timeout guard during execution
        if time.perf_counter() - start_time > timeout:
            raise TimeoutError(f"Execution timed out after {timeout:.1f} seconds.")

        # Don't record internal guard exceptions as steps
        if event == "exception" and isinstance(arg[1], (StepLimitExceeded, TimeoutError)):
            return tracer

        # Build stack of frames belonging to user code
        curr = frame
        user_frames = []
        while curr is not None and curr.f_code.co_filename == "<user_code>":
            user_frames.append(curr)
            curr = curr.f_back
        user_frames.reverse()

        # Snapshot stack frames and heap graph
        stack, heap = serializer.serialize_step(
            user_frames,
            event=event,
            return_arg=arg if event == "return" else None,
        )

        current_stdout = stdout_buffer.getvalue()
        current_step_num = len(steps)

        steps.append({
            "step": current_step_num,
            "event": event,
            "line": frame.f_lineno,
            "func_name": frame.f_code.co_name,
            "stdout": current_stdout,
            "stack": stack,
            "heap": heap,
        })

        return tracer

    with _stdout_lock:
        old_stdout = sys.stdout
        sys.stdout = stdout_buffer
        sys.settrace(tracer)
        try:
            exec(code_obj, exec_globals)
        except StepLimitExceeded as e:
            return {
                "status": "error",
                "code": code,
                "total_steps": len(steps),
                "steps": steps,
                "error": {
                    "type": "RuntimeError",
                    "message": str(e),
                    "line": last_lineno,
                    "traceback": f"StepLimitExceeded: {str(e)}",
                },
            }
        except TimeoutError as e:
            return {
                "status": "error",
                "code": code,
                "total_steps": len(steps),
                "steps": steps,
                "error": {
                    "type": "TimeoutError",
                    "message": str(e),
                    "line": last_lineno,
                    "traceback": f"TimeoutError: {str(e)}",
                },
            }
        except SecurityError as e:
            return {
                "status": "error",
                "code": code,
                "total_steps": len(steps),
                "steps": steps,
                "error": {
                    "type": "SecurityError",
                    "message": e.message,
                    "line": e.lineno or last_lineno,
                    "traceback": traceback.format_exc(),
                },
            }
        except Exception as e:
            tb = e.__traceback__
            err_line = None
            while tb is not None:
                if tb.tb_frame.f_code.co_filename == "<user_code>":
                    err_line = tb.tb_lineno
                tb = tb.tb_next
            if err_line is None:
                err_line = last_lineno

            return {
                "status": "error",
                "code": code,
                "total_steps": len(steps),
                "steps": steps,
                "error": {
                    "type": type(e).__name__,
                    "message": str(e),
                    "line": err_line,
                    "traceback": traceback.format_exc(),
                },
            }
        finally:
            sys.settrace(None)
            sys.stdout = old_stdout

    return {
        "status": "ok",
        "code": code,
        "total_steps": len(steps),
        "steps": steps,
        "error": None,
    }


def execute_trace_sandboxed(
    code: str,
    max_steps: int = MAX_STEPS,
    timeout: float = TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    """Executes code tracing inside an isolated subprocess with an OS watchdog timeout."""
    payload = json.dumps({"code": code, "max_steps": max_steps, "timeout": timeout})
    repo_root = str(Path(__file__).resolve().parent.parent)
    child_env = {**os.environ, "PYTHONPATH": repo_root}
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "backend.tracer"],
            input=payload,
            text=True,
            capture_output=True,
            timeout=timeout + 1.0,
            cwd=repo_root,
            env=child_env,
        )
        if proc.returncode != 0:
            # Child process crashed or stderr output
            err_msg = proc.stderr.strip() or f"Process exited with code {proc.returncode}"
            return {
                "status": "error",
                "error": {
                    "type": "RuntimeError",
                    "message": err_msg,
                    "line": None,
                    "traceback": err_msg,
                },
            }
        return json.loads(proc.stdout)
    except subprocess.TimeoutExpired:
        return {
            "status": "error",
            "error": {
                "type": "TimeoutError",
                "message": f"Execution timed out after {timeout:.1f} seconds.",
                "line": None,
                "traceback": "TimeoutError: Execution timed out.",
            },
        }
    except Exception as e:
        return {
            "status": "error",
            "error": {
                "type": type(e).__name__,
                "message": str(e),
                "line": None,
                "traceback": traceback.format_exc(),
            },
        }


if __name__ == "__main__":
    try:
        raw_input_data = sys.stdin.read()
        req = json.loads(raw_input_data)
        user_code = req.get("code", "")
        req_max_steps = req.get("max_steps", MAX_STEPS)
        req_timeout = req.get("timeout", TIMEOUT_SECONDS)
        result = trace_code(user_code, max_steps=req_max_steps, timeout=req_timeout)
        print(json.dumps(result))
    except Exception as exc:
        err_res = {
            "status": "error",
            "error": {
                "type": type(exc).__name__,
                "message": str(exc),
                "line": None,
                "traceback": traceback.format_exc(),
            },
        }
        print(json.dumps(err_res))
