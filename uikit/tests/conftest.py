import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

import ui  # noqa: E402


class FakeDOM:
    """Applies the op stream like renderer.js does, into plain Python nodes."""

    def __init__(self):
        self.nodes = {0: {"i": 0, "t": "#root", "p": {}, "kids": []}}
        self.messages = []
        self.ops = []
        self.calls = []

    def render(self, payload):
        msg = json.loads(payload)
        self.messages.append(msg)
        for op in msg["ops"]:
            self.ops.append(op)
            getattr(self, "op_" + op[0])(*op[1:])

    def build(self, tree):
        node = {"i": tree["i"], "t": tree["t"], "p": dict(tree.get("p", {})), "kids": [], "parent": None}
        assert tree["i"] not in self.nodes, f"duplicate id {tree['i']}"
        self.nodes[tree["i"]] = node
        for c in tree.get("c", []):
            kid = self.build(c)
            kid["parent"] = node
            node["kids"].append(kid)
        return node

    def insert(self, parent_id, node, before_id):
        parent = self.nodes[parent_id]
        if node.get("parent") is not None:
            node["parent"]["kids"].remove(node)
        node["parent"] = parent
        if before_id is None:
            parent["kids"].append(node)
        else:
            before = self.nodes[before_id]
            assert before["parent"] is parent, "anchor is not a child of the parent"
            parent["kids"].insert(parent["kids"].index(before), node)

    def op_mount(self, parent_id, before_id, tree):
        self.insert(parent_id, self.build(tree), before_id)

    def op_move(self, parent_id, node_id, before_id):
        self.insert(parent_id, self.nodes[node_id], before_id)

    def op_unmount(self, node_id):
        node = self.nodes[node_id]
        node["parent"]["kids"].remove(node)
        node["parent"] = None

        def forget(n):
            self.nodes.pop(n["i"], None)
            for k in n["kids"]:
                forget(k)

        forget(node)

    def op_set(self, node_id, props):
        if node_id in self.nodes:
            self.nodes[node_id]["p"].update(props)

    def op_call(self, *args):
        self.calls.append(("call", *args))

    def op_config(self, config):
        self.config = config

    def op_dialog(self, i, spec):
        self.calls.append(("dialog", i, spec))

    def op_toast(self, text, seconds):
        self.calls.append(("toast", text))

    def op_close(self):
        self.calls.append(("close",))

    def op_reset(self):
        self.nodes = {0: {"i": 0, "t": "#root", "p": {}, "kids": []}}

    def op_frame(self, node_id):
        self.calls.append(("frame", node_id))

    # -- queries --

    @property
    def root(self):
        return self.nodes[0]

    def find_all(self, t, node=None):
        node = node or self.root
        out = [node] if node["t"] == t else []
        for k in node["kids"]:
            out.extend(self.find_all(t, k))
        return out

    def find(self, t, **props):
        for n in self.find_all(t):
            if all(n["p"].get(k) == v for k, v in props.items()):
                return n
        raise LookupError(f"no {t} with {props}")

    def text(self, node=None):
        node = node or self.root
        if node["t"] == "#text":
            return node["p"].get("text", "")
        own = node["p"].get("text") or node["p"].get("label") or node["p"].get("title") or ""
        return own + "".join(self.text(k) for k in node["kids"])


class Harness:
    def __init__(self):
        self.dom = FakeDOM()
        ui._app.host = self.dom
        ui._app.schedule_fn = lambda fn: None

    def run(self, app, **kw):
        ui.run(app, **kw)
        return self.dom

    def flush(self):
        ui._app.flush()

    def fire(self, node, event, *args):
        node_id = node["i"] if isinstance(node, dict) else getattr(node, "id", node)
        ui._app.dispatch(f"{node_id}:{event}", json.dumps(list(args)))

    def ops_since(self, n):
        return self.dom.ops[n:]


@pytest.fixture
def h():
    ui._rt = ui._Runtime()
    ui._app = ui._App()
    ui._warned.clear()
    yield Harness()
    ui._app.stop()
