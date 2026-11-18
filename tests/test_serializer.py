"""
Tier 1 and Tier 2 Unit and Boundary Tests for BFS Heap Serialization (serializer.py).

Tests separation of primitives vs references, stable heap IDs, immutable step snapshots,
circular references, slotted objects, aliasing, and empty collections.
"""

import sys
from pathlib import Path
import pytest

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.serializer import Serializer
from backend.tracer import trace_code


class TestSerializerTier1Unit:
    """Tier 1: Primitives, collections, references, and stable heap IDs."""

    def test_primitive_types_inlined_not_on_heap(self):
        """T1.6: Primitives (int, float, bool, str, None) are inlined, not referenced on heap."""
        ser = Serializer()
        assert not ser.is_reference(42)
        assert not ser.is_reference(3.14)
        assert not ser.is_reference("string")
        assert not ser.is_reference(True)
        assert not ser.is_reference(False)
        assert not ser.is_reference(None)

        code = (
            "i = 100\n"
            "f = 2.5\n"
            "s = 'visualize'\n"
            "b = True\n"
            "n = None\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        final_step = res["steps"][-1]
        active_vars = final_step["stack"][0]["variables"]

        assert active_vars["i"] == {"kind": "primitive", "type": "int", "value": 100}
        assert active_vars["f"] == {"kind": "primitive", "type": "float", "value": 2.5}
        assert active_vars["s"] == {"kind": "primitive", "type": "str", "value": "visualize"}
        assert active_vars["b"] == {"kind": "primitive", "type": "bool", "value": True}
        assert active_vars["n"] == {"kind": "primitive", "type": "none", "value": None}
        # Heap should have zero objects because all variables are primitive
        assert len(final_step["heap"]) == 0

    def test_list_serialization_with_slots_and_references(self):
        """T1.7: List serialization creates heap object with items and length."""
        code = (
            "lst = [10, 20, 30]\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        final_step = res["steps"][-1]
        var_lst = final_step["stack"][0]["variables"]["lst"]

        assert var_lst["kind"] == "ref"
        heap_id = var_lst["target"]
        heap_obj = final_step["heap"][heap_id]
        assert heap_obj["type"] == "list"
        assert heap_obj["length"] == 3
        assert len(heap_obj["items"]) == 3
        assert heap_obj["items"][0] == {"kind": "primitive", "type": "int", "value": 10}
        assert heap_obj["items"][1] == {"kind": "primitive", "type": "int", "value": 20}
        assert heap_obj["items"][2] == {"kind": "primitive", "type": "int", "value": 30}

    def test_dict_serialization_with_key_value_entries(self):
        """T1.8: Dict serialization captures entries array with key and value descriptors."""
        code = (
            "d = {'name': 'test', 'score': 99}\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        final_step = res["steps"][-1]
        var_d = final_step["stack"][0]["variables"]["d"]

        assert var_d["kind"] == "ref"
        heap_obj = final_step["heap"][var_d["target"]]
        assert heap_obj["type"] == "dict"
        assert heap_obj["length"] == 2
        assert len(heap_obj["entries"]) == 2

        entries = {e["key"]["value"]: e["value"]["value"] for e in heap_obj["entries"]}
        assert entries["name"] == "test"
        assert entries["score"] == 99

    def test_set_and_tuple_serialization(self):
        """T1.9: Sets and tuples are serialized to heap with correct types."""
        code = (
            "s = {1, 2}\n"
            "t = (3, 4)\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        final_step = res["steps"][-1]
        vars_dict = final_step["stack"][0]["variables"]

        # Set
        s_ref = vars_dict["s"]["target"]
        s_obj = final_step["heap"][s_ref]
        assert s_obj["type"] == "set"
        assert s_obj["length"] == 2

        # Tuple
        t_ref = vars_dict["t"]["target"]
        t_obj = final_step["heap"][t_ref]
        assert t_obj["type"] == "tuple"
        assert t_obj["length"] == 2
        assert t_obj["items"][0]["value"] == 3
        assert t_obj["items"][1]["value"] == 4

    def test_immutable_step_snapshots_across_mutations(self):
        """T1.10: In-place mutation in step K does not corrupt step K-1 snapshot."""
        code = (
            "nums = [1]\n"
            "nums.append(2)\n"
            "nums.append(3)\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"

        # Find steps corresponding to each append
        append_steps = [s for s in res["steps"] if s["event"] == "line"]
        assert len(append_steps) >= 3

        # First line: nums = [1]
        first_step_heap = append_steps[1]["heap"]
        target_id = append_steps[1]["stack"][0]["variables"]["nums"]["target"]
        assert len(first_step_heap[target_id]["items"]) == 1
        assert first_step_heap[target_id]["items"][0]["value"] == 1

        # Final line: nums = [1, 2, 3]
        final_step_heap = res["steps"][-1]["heap"]
        assert len(final_step_heap[target_id]["items"]) == 3

        # CRITICAL ASSERTION: The first step snapshot MUST STILL have length 1!
        assert len(first_step_heap[target_id]["items"]) == 1


class TestSerializerTier2Boundary:
    """Tier 2: Circular references, slotted objects, aliasing, empty structures."""

    def test_direct_serializer_custom_class_instance(self):
        """T2.1: Serializer extracts custom class attributes into heap instance."""
        class MockNode:
            def __init__(self, val):
                self.val = val
                self.next = None

        node = MockNode(10)
        ser = Serializer()
        assert ser.is_reference(node)

        # Create mock frame-like object
        class MockFrame:
            f_code = type("Code", (), {"co_name": "test_func", "co_filename": "<user_code>"})()
            f_lineno = 10
            f_locals = {"n": node}

        stack, heap = ser.serialize_step([MockFrame()], event="line")
        assert len(stack) == 1
        assert stack[0]["variables"]["n"]["kind"] == "ref"
        node_id = stack[0]["variables"]["n"]["target"]

        assert node_id in heap
        assert heap[node_id]["type"] == "instance"
        assert heap[node_id]["class_name"] == "MockNode"
        assert heap[node_id]["attrs"]["val"]["value"] == 10
        assert heap[node_id]["attrs"]["next"]["value"] is None

    def test_slotted_class_without_dict(self):
        """T2.2: Slotted classes (__slots__) without __dict__ serialize properly."""
        class SlottedNode:
            __slots__ = ("val", "next")
            def __init__(self, val, next=None):
                self.val = val
                self.next = next

        node = SlottedNode(42)
        assert not hasattr(node, "__dict__")

        ser = Serializer()
        class MockFrame:
            f_code = type("Code", (), {"co_name": "test_func", "co_filename": "<user_code>"})()
            f_lineno = 5
            f_locals = {"s": node}

        stack, heap = ser.serialize_step([MockFrame()], event="line")
        node_id = stack[0]["variables"]["s"]["target"]
        assert heap[node_id]["type"] == "instance"
        assert heap[node_id]["class_name"] == "SlottedNode"
        assert heap[node_id]["attrs"]["val"]["value"] == 42
        assert heap[node_id]["attrs"]["next"]["value"] is None

    def test_self_referencing_circular_object(self):
        """T2.3: Object referencing itself (a.next = a) does not cause infinite recursion."""
        class Node:
            def __init__(self, name):
                self.name = name
                self.next = None

        a = Node("A")
        a.next = a  # Self loop

        ser = Serializer()
        class MockFrame:
            f_code = type("Code", (), {"co_name": "test_cycle", "co_filename": "<user_code>"})()
            f_lineno = 12
            f_locals = {"node": a}

        stack, heap = ser.serialize_step([MockFrame()], event="line")
        node_id = stack[0]["variables"]["node"]["target"]
        assert heap[node_id]["attrs"]["next"]["kind"] == "ref"
        assert heap[node_id]["attrs"]["next"]["target"] == node_id

    def test_mutual_two_node_cycle(self):
        """T2.4: Mutual cycle (a.next = b; b.next = a) terminates cleanly in BFS."""
        class Node:
            def __init__(self, val):
                self.val = val
                self.next = None

        a = Node(1)
        b = Node(2)
        a.next = b
        b.next = a

        ser = Serializer()
        class MockFrame:
            f_code = type("Code", (), {"co_name": "test_cycle", "co_filename": "<user_code>"})()
            f_lineno = 15
            f_locals = {"a": a, "b": b}

        stack, heap = ser.serialize_step([MockFrame()], event="line")
        a_id = stack[0]["variables"]["a"]["target"]
        b_id = stack[0]["variables"]["b"]["target"]

        assert heap[a_id]["attrs"]["next"]["target"] == b_id
        assert heap[b_id]["attrs"]["next"]["target"] == a_id

    def test_aliasing_multiple_variables_same_heap_id(self):
        """T2.5: Variables referencing the same mutable object share identical heap ID."""
        code = (
            "orig = [1, 2]\n"
            "alias1 = orig\n"
            "alias2 = orig\n"
            "nested = [orig, alias1]\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        final_step = res["steps"][-1]
        vars_dict = final_step["stack"][0]["variables"]

        orig_id = vars_dict["orig"]["target"]
        alias1_id = vars_dict["alias1"]["target"]
        alias2_id = vars_dict["alias2"]["target"]

        # All aliases must have the EXACT SAME heap target ID
        assert orig_id == alias1_id == alias2_id

        # Nested list's items must also point to this same heap target ID
        nested_id = vars_dict["nested"]["target"]
        nested_items = final_step["heap"][nested_id]["items"]
        assert nested_items[0]["target"] == orig_id
        assert nested_items[1]["target"] == orig_id

    def test_empty_collections_serialization(self):
        """T2.6: Empty list, dict, set, and tuple serialize with length 0."""
        code = (
            "empty_list = []\n"
            "empty_dict = {}\n"
            "empty_set = set()\n"
            "empty_tuple = ()\n"
        )
        res = trace_code(code)
        assert res["status"] == "ok"
        final_step = res["steps"][-1]
        vars_dict = final_step["stack"][0]["variables"]
        heap = final_step["heap"]

        assert heap[vars_dict["empty_list"]["target"]]["length"] == 0
        assert heap[vars_dict["empty_list"]["target"]]["items"] == []

        assert heap[vars_dict["empty_dict"]["target"]]["length"] == 0
        assert heap[vars_dict["empty_dict"]["target"]]["entries"] == []

        assert heap[vars_dict["empty_set"]["target"]]["length"] == 0
        assert heap[vars_dict["empty_set"]["target"]]["items"] == []

        assert heap[vars_dict["empty_tuple"]["target"]]["length"] == 0
        assert heap[vars_dict["empty_tuple"]["target"]]["items"] == []

    def test_float_nan_and_infinity_serialization(self):
        """T2.7: Special float values NaN, Infinity, -Infinity are handled safely in JSON."""
        ser = Serializer()
        class MockFrame:
            f_code = type("Code", (), {"co_name": "test_floats", "co_filename": "<user_code>"})()
            f_lineno = 1
            f_locals = {
                "nan_val": float("nan"),
                "pos_inf": float("inf"),
                "neg_inf": float("-inf"),
            }

        stack, heap = ser.serialize_step([MockFrame()], event="line")
        vars_dict = stack[0]["variables"]
        assert vars_dict["nan_val"]["value"] == "NaN"
        assert vars_dict["pos_inf"]["value"] == "Infinity"
        assert vars_dict["neg_inf"]["value"] == "-Infinity"

    def test_slotted_class_with_hostile_getattr(self):
        """Verifies slotted instance with hostile __getattr__ raising RuntimeError serializes cleanly."""
        class HostileSlotted:
            __slots__ = ("val",)
            def __init__(self, val):
                self.val = val
            def __getattr__(self, name):
                raise RuntimeError("Hostile __getattr__ invoked!")

        obj = HostileSlotted(123)
        ser = Serializer()
        class MockFrame:
            f_code = type("Code", (), {"co_name": "test_hostile", "co_filename": "<user_code>"})()
            f_lineno = 1
            f_locals = {"obj": obj}

        stack, heap = ser.serialize_step([MockFrame()], event="line")
        node_id = stack[0]["variables"]["obj"]["target"]
        assert heap[node_id]["attrs"]["val"]["value"] == 123

    def test_deeply_nested_lists_up_to_limit(self):
        """T2.6: Deeply nested lists (500 levels) serialize via iterative BFS without RecursionError."""
        # Construct 500-level nested list: [ [ ... [42] ... ] ]
        curr_list = [42]
        for _ in range(500):
            curr_list = [curr_list]

        ser = Serializer(max_objects=1000)

        class MockFrameList:
            f_code = type("Code", (), {"co_name": "test_deep_list", "co_filename": "<user_code>"})()
            f_lineno = 1
            f_locals = {"root_list": curr_list}

        stack, heap = ser.serialize_step([MockFrameList()], event="line")

        # 1. Stack assertions
        assert len(stack) == 1
        root_ref = stack[0]["variables"]["root_list"]
        assert root_ref["kind"] == "ref"

        # 2. Heap object count assertions: 500 nested wrappers + 1 leaf list = 501
        assert len(heap) == 501

        # 3. Traversal assertion: follow reference chain from root to leaf
        curr_id = root_ref["target"]
        for _ in range(500):
            assert curr_id in heap
            assert heap[curr_id]["type"] == "list"
            assert heap[curr_id]["length"] == 1
            assert heap[curr_id]["items"][0]["kind"] == "ref"
            curr_id = heap[curr_id]["items"][0]["target"]

        # 4. Leaf assertions
        assert curr_id in heap
        assert heap[curr_id]["type"] == "list"
        assert heap[curr_id]["length"] == 1
        assert heap[curr_id]["items"][0] == {"kind": "primitive", "type": "int", "value": 42}

    def test_deeply_nested_dicts_up_to_limit(self):
        """T2.6: Deeply nested dicts (500 levels) serialize via iterative BFS without RecursionError."""
        # Construct 500-level nested dict: {'level_499': ... {'level_0': {'leaf': 'deep_value'}}...}
        curr_dict = {"leaf": "deep_value"}
        for i in range(500):
            curr_dict = {f"level_{i}": curr_dict}

        ser_dict = Serializer(max_objects=1000)

        class MockFrameDict:
            f_code = type("Code", (), {"co_name": "test_deep_dict", "co_filename": "<user_code>"})()
            f_lineno = 1
            f_locals = {"root_dict": curr_dict}

        stack_d, heap_d = ser_dict.serialize_step([MockFrameDict()], event="line")

        # 1. Stack assertions
        assert len(stack_d) == 1
        root_dict_ref = stack_d[0]["variables"]["root_dict"]
        assert root_dict_ref["kind"] == "ref"

        # 2. Heap object count assertions: 501 dicts
        assert len(heap_d) == 501

        # 3. Traversal assertion: follow dictionary chain from outer to inner
        curr_d_id = root_dict_ref["target"]
        for i in reversed(range(500)):
            assert curr_d_id in heap_d
            assert heap_d[curr_d_id]["type"] == "dict"
            assert heap_d[curr_d_id]["length"] == 1
            assert heap_d[curr_d_id]["entries"][0]["key"]["value"] == f"level_{i}"
            assert heap_d[curr_d_id]["entries"][0]["value"]["kind"] == "ref"
            curr_d_id = heap_d[curr_d_id]["entries"][0]["value"]["target"]

        # 4. Leaf dictionary assertions
        assert curr_d_id in heap_d
        assert heap_d[curr_d_id]["type"] == "dict"
        assert heap_d[curr_d_id]["entries"][0]["key"]["value"] == "leaf"
        assert heap_d[curr_d_id]["entries"][0]["value"] == {
            "kind": "primitive",
            "type": "str",
            "value": "deep_value",
        }

    def test_max_objects_capping_on_nested_structures(self):
        """T2.6b: Serializer caps reachable heap objects at max_objects without raising error."""
        ser = Serializer(max_objects=100)
        curr = [0]
        for _ in range(200):
            curr = [curr]

        class MockFrame:
            f_code = type("Code", (), {"co_name": "test_cap", "co_filename": "<user_code>"})()
            f_lineno = 1
            f_locals = {"root": curr}

        stack, heap = ser.serialize_step([MockFrame()], event="line")
        assert len(stack) == 1
        assert len(heap) == 100

