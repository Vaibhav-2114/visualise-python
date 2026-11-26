"""Serializer for call stack frames and heap graph.

Conforms strictly to PROJECT.md § Interface Contracts:
- Inlines primitives (int, float, bool, str, none).
- Allocates stable heap object IDs (obj_1, obj_2, ...) in order of discovery.
- Anchors objects in persistent pool (_anchor_pool) to prevent CPython memory recycling.
- Employs iterative BFS traversal with visited set for circular reference resolution.
- Produces immutable per-step snapshots immune to future runtime mutations.
- Supports custom classes (__dict__ and __slots__), lists, dicts, sets, and tuples.
"""

import collections
import math
import types
from typing import Any, Dict, List, Set, Tuple

from .limits import MAX_OBJECTS, MAX_STRING_LENGTH


class Serializer:
    """Manages object identity and serializes execution state snapshots."""

    def __init__(
        self,
        max_objects: int = MAX_OBJECTS,
        max_string_length: int = MAX_STRING_LENGTH,
    ):
        self.max_objects = max_objects
        self.max_string_length = max_string_length
        # Anchors prevent CPython from recycling object virtual addresses
        self._anchor_pool: Dict[int, Any] = {}
        # Stable ID mapping from id(obj) -> 'obj_1', 'obj_2', ...
        self._id_map: Dict[int, str] = {}
        self._next_id: int = 1

    def _is_typing_object(self, val: Any) -> bool:
        """Return whether val is a typing annotation or runtime type alias."""
        cls = getattr(val, "__class__", None)
        if cls is not None and getattr(cls, "__module__", None) == "typing":
            return True
        if isinstance(val, types.GenericAlias):
            return True
        return hasattr(types, "UnionType") and isinstance(val, types.UnionType)

    def is_reference(self, val: Any) -> bool:
        """Determines whether a value should be allocated as a heap object reference."""
        if val is None:
            return False
        # Booleans inherit from int, so check bool first
        if isinstance(val, bool):
            return False
        if isinstance(val, (int, float, str, bytes)):
            return False
        if isinstance(val, type):
            return False
        if isinstance(val, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
            return False
        if isinstance(val, types.ModuleType):
            return False
        if self._is_typing_object(val):
            return False
        # Containers on heap
        if isinstance(val, (list, dict, set, tuple)):
            return True
        # Custom class instance or complex object
        if hasattr(val, "__class__"):
            cls = val.__class__
            if cls.__module__ == "builtins" and cls.__name__ in (
                "int", "float", "str", "bool", "bytes", "complex", "code"
            ):
                return False
            return True
        return False

    def get_object_id(self, obj: Any) -> str:
        """Returns or creates a stable object ID ('obj_X') for the given object."""
        oid = id(obj)
        if oid not in self._id_map:
            assigned = f"obj_{self._next_id}"
            self._next_id += 1
            self._id_map[oid] = assigned
            self._anchor_pool[oid] = obj
        return self._id_map[oid]

    def _serialize_value(
        self,
        val: Any,
        visited_in_step: Set[str],
        bfs_queue: collections.deque,
    ) -> Dict[str, Any]:
        """Serializes an individual value descriptor (primitive, ref, class, func, other)."""
        if self.is_reference(val):
            target_id = self.get_object_id(val)
            if target_id not in visited_in_step:
                visited_in_step.add(target_id)
                bfs_queue.append((target_id, val))
            return {"kind": "ref", "target": target_id}

        if isinstance(val, bool):
            return {"kind": "primitive", "type": "bool", "value": val}

        if isinstance(val, int):
            return {"kind": "primitive", "type": "int", "value": val}

        if isinstance(val, float):
            if math.isnan(val):
                v: Any = "NaN"
            elif math.isinf(val):
                v = "Infinity" if val > 0 else "-Infinity"
            else:
                v = val
            return {"kind": "primitive", "type": "float", "value": v}

        if isinstance(val, str):
            truncated = val[: self.max_string_length]
            return {"kind": "primitive", "type": "str", "value": truncated}

        if val is None:
            return {"kind": "primitive", "type": "none", "value": None}

        if isinstance(val, type):
            return {"kind": "class", "name": val.__name__}

        if self._is_typing_object(val):
            name = getattr(val, "_name", None) or getattr(val, "__name__", None) or repr(val)
            name = str(name).replace("typing.", "")
            return {"kind": "class", "name": name if name.startswith("typing.") else f"typing.{name}"}

        if isinstance(val, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
            line = getattr(getattr(val, "__code__", None), "co_firstlineno", None)
            name = getattr(val, "__name__", "<function>")
            return {"kind": "function", "name": name, "line": line}

        return {"kind": "other", "repr": repr(val)[: self.max_string_length]}

    def _extract_instance_attributes(self, obj: Any) -> Dict[str, Any]:
        """Extracts attributes from both standard __dict__ and slotted __slots__ classes."""
        raw_attrs: Dict[str, Any] = {}

        try:
            d = object.__getattribute__(obj, "__dict__")
            if isinstance(d, dict):
                for k, v in d.items():
                    if not (isinstance(k, str) and k.startswith("__") and k.endswith("__")):
                        raw_attrs[k] = v
        except Exception:
            pass

        for cls in type(obj).__mro__:
            slots = getattr(cls, "__slots__", None)
            if slots:
                if isinstance(slots, str):
                    slots = [slots]
                for s in slots:
                    if not (isinstance(s, str) and s.startswith("__") and s.endswith("__")):
                        try:
                            raw_attrs[s] = getattr(obj, s)
                        except Exception:
                            pass

        return raw_attrs

    def extract_frame_variables(self, frame: Any) -> Dict[str, Any]:
        """Extracts and filters user-visible variables from an execution frame."""
        raw_vars = dict(frame.f_locals)
        filtered = {}
        for k, v in raw_vars.items():
            if k.startswith("__") and k.endswith("__"):
                continue
            filtered[k] = v
        return filtered

    def serialize_step(
        self,
        user_frames: List[Any],
        event: str,
        return_arg: Any = None,
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
        """Produces an immutable snapshot of call stack frames and reachable heap objects."""
        visited_in_step: Set[str] = set()
        bfs_queue: collections.deque = collections.deque()
        serialized_stack: List[Dict[str, Any]] = []

        # 1. Process stack frames bottom-to-top
        for idx, frame in enumerate(user_frames):
            frame_id = f"frame_{idx}"
            func_name = frame.f_code.co_name
            lineno = frame.f_lineno
            is_active = (idx == len(user_frames) - 1)

            raw_vars = self.extract_frame_variables(frame)
            variables: Dict[str, Any] = {}
            for var_name, var_val in raw_vars.items():
                variables[var_name] = self._serialize_value(
                    var_val, visited_in_step, bfs_queue
                )

            frame_entry: Dict[str, Any] = {
                "frame_id": frame_id,
                "func_name": func_name,
                "lineno": lineno,
                "is_active": is_active,
                "variables": variables,
            }

            if event == "return" and is_active:
                frame_entry["return_value"] = self._serialize_value(
                    return_arg, visited_in_step, bfs_queue
                )
            else:
                frame_entry["return_value"] = None

            serialized_stack.append(frame_entry)

        # 2. Iteratively drain BFS queue to build reachable heap graph
        step_heap: Dict[str, Dict[str, Any]] = {}
        while bfs_queue:
            target_id, obj = bfs_queue.popleft()
            if len(step_heap) >= self.max_objects:
                continue

            if isinstance(obj, list):
                items = [
                    self._serialize_value(item, visited_in_step, bfs_queue)
                    for item in obj
                ]
                step_heap[target_id] = {
                    "id": target_id,
                    "type": "list",
                    "items": items,
                    "length": len(obj),
                    **({"class_name": type(obj).__name__} if type(obj) is not list else {}),
                }

            elif isinstance(obj, tuple):
                items = [
                    self._serialize_value(item, visited_in_step, bfs_queue)
                    for item in obj
                ]
                step_heap[target_id] = {
                    "id": target_id,
                    "type": "tuple",
                    "items": items,
                    "length": len(obj),
                    **({"class_name": type(obj).__name__} if type(obj) is not tuple else {}),
                }

            elif isinstance(obj, set):
                items = [
                    self._serialize_value(item, visited_in_step, bfs_queue)
                    for item in obj
                ]
                step_heap[target_id] = {
                    "id": target_id,
                    "type": "set",
                    "items": items,
                    "length": len(obj),
                    **({"class_name": type(obj).__name__} if type(obj) is not set else {}),
                }

            elif isinstance(obj, dict):
                entries = []
                for k, v in obj.items():
                    k_ser = self._serialize_value(k, visited_in_step, bfs_queue)
                    v_ser = self._serialize_value(v, visited_in_step, bfs_queue)
                    entries.append({"key": k_ser, "value": v_ser})
                step_heap[target_id] = {
                    "id": target_id,
                    "type": "dict",
                    "entries": entries,
                    "length": len(obj),
                    **({"class_name": type(obj).__name__} if type(obj) is not dict else {}),
                }

            else:
                # Custom instance
                class_name = obj.__class__.__name__
                raw_attrs = self._extract_instance_attributes(obj)
                attrs: Dict[str, Any] = {}
                for attr_name, attr_val in raw_attrs.items():
                    attrs[attr_name] = self._serialize_value(
                        attr_val, visited_in_step, bfs_queue
                    )
                step_heap[target_id] = {
                    "id": target_id,
                    "type": "instance",
                    "class_name": class_name,
                    "attrs": attrs,
                }

        return serialized_stack, step_heap
