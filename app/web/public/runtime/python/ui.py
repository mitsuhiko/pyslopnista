"""A tiny declarative UI toolkit (spike).

The view is a function of state. Calling ``ui.run(view)`` renders it; whenever
a ``State`` changes, the view function runs again and the new tree is sent to
the page, which patches the DOM.

    import ui

    count = ui.state(0)

    def view():
        return ui.Screen(
            "Counter",
            ui.Text(f"{count.value} taps", style="largeTitle"),
            ui.Button("Tap me", on_tap=lambda: count.set(count.value + 1)),
        )

    ui.run(view)
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import traceback

__all__ = [
    "Button", "HStack", "Image", "Row", "Screen", "Section", "Slider", "Spacer",
    "State", "Text", "TextField", "Toggle", "VStack", "run", "state",
]


# -- state -------------------------------------------------------------------

class State:
    """A value that re-renders the UI when it changes."""

    def __init__(self, value):
        self._value = value

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, new):
        self.set(new)

    def set(self, new):
        self._value = new
        _app.invalidate()

    def update(self, fn):
        """Set the value to ``fn(old_value)``."""
        self.set(fn(self._value))

    def __repr__(self):
        return f"State({self._value!r})"


def state(initial=None) -> State:
    return State(initial)


# -- nodes ---------------------------------------------------------------------

class Node:
    __slots__ = ("type", "props", "children", "key")

    def __init__(self, type, props, children=(), key=None):
        self.type = type
        self.props = props
        self.children = children
        self.key = key

    def __repr__(self):
        return f"<{self.type} {self.props!r} children={len(self.children)}>"


def _flatten(items):
    out = []
    for item in items:
        if item is None or item is False or item is True:
            continue
        if isinstance(item, (list, tuple)) or inspect.isgenerator(item):
            out.extend(_flatten(item))
        elif isinstance(item, Node):
            out.append(item)
        else:
            out.append(Text(str(item)))
    return out


def _node(type, children=(), key=None, **props):
    props = {k: v for k, v in props.items() if v is not None}
    return Node(type, props, _flatten(children), key)


# -- components ----------------------------------------------------------------

def Screen(title=None, *children, key=None):
    """A full screen with a large navigation title and scrolling content."""
    return _node("Screen", children, key, title=title)


def Section(*children, header=None, footer=None, key=None):
    """An inset grouped list section (iOS Settings style)."""
    return _node("Section", children, key, header=header, footer=footer)


def VStack(*children, spacing=8, align="stretch", padding=None, key=None):
    return _node("VStack", children, key, spacing=spacing, align=align, padding=padding)


def HStack(*children, spacing=8, align="center", padding=None, key=None):
    return _node("HStack", children, key, spacing=spacing, align=align, padding=padding)


def Spacer(key=None):
    return _node("Spacer", (), key)


def Text(text, style="body", color=None, key=None):
    """style: largeTitle, title, headline, body, callout, subheadline, footnote, caption"""
    return _node("Text", (), key, text=str(text), style=style, color=color)


def Button(label, on_tap=None, style="filled", disabled=False, key=None):
    """style: filled, tinted, plain, destructive"""
    return _node("Button", (), key, label=str(label), on_tap=on_tap, style=style, disabled=disabled or None)


def TextField(value="", placeholder="", on_change=None, on_submit=None, key=None):
    return _node("TextField", (), key, value=value, placeholder=placeholder,
                 on_change=on_change, on_submit=on_submit)


def Toggle(label, value=False, on_change=None, key=None):
    return _node("Toggle", (), key, label=str(label), value=bool(value), on_change=on_change)


def Slider(value=0.0, min=0.0, max=1.0, step=None, on_change=None, key=None):
    return _node("Slider", (), key, value=value, min=min, max=max, step=step, on_change=on_change)


def Row(title, subtitle=None, detail=None, checked=None, on_tap=None, on_delete=None, key=None):
    """A list row, for use inside a Section."""
    return _node("Row", (), key, title=str(title), subtitle=subtitle, detail=detail,
                 checked=checked, on_tap=on_tap, on_delete=on_delete)


def Image(src, width=None, height=None, key=None):
    return _node("Image", (), key, src=src, width=width, height=height)


# -- app -------------------------------------------------------------------------

class _App:
    def __init__(self):
        self.view = None
        self.callbacks = {}
        self.seq = 0
        self.dirty = False
        self.dispatching = False
        self.flush_scheduled = False
        self.last_render_ms = 0.0

    def run(self, view):
        import _uihost
        from pyodide.ffi import create_proxy

        self.view = view
        _uihost.set_dispatcher(create_proxy(self.dispatch))
        self.render()

    def invalidate(self):
        if self.view is None:
            return
        self.dirty = True
        if self.dispatching or self.flush_scheduled:
            return
        # State changed outside an event handler (e.g. in a timer or an async
        # task): batch all changes made in the same tick into one render.
        self.flush_scheduled = True
        asyncio.get_event_loop().call_soon(self.flush)

    def flush(self):
        self.flush_scheduled = False
        if self.dirty:
            self.render()

    def render(self):
        import _uihost

        t0 = time.perf_counter()
        self.dirty = False
        self.callbacks = {}
        try:
            tree = self.view()
        except Exception:
            traceback.print_exc()
            return
        payload = self.serialize(tree, "r")
        self.seq += 1
        self.last_render_ms = (time.perf_counter() - t0) * 1000
        _uihost.render(json.dumps({"seq": self.seq, "root": payload, "pyMs": round(self.last_render_ms, 3)}))

    def serialize(self, node, path):
        props = {}
        for name, value in node.props.items():
            if callable(value):
                # Ids are positional, so they stay stable across renders and an
                # event from a not-yet-patched DOM still reaches the handler that
                # now occupies the same slot.
                cb_id = f"{path}.{name}"
                self.callbacks[cb_id] = value
                props[name] = {"$cb": cb_id}
            else:
                props[name] = value
        out = {"t": node.type, "p": props}
        if node.key is not None:
            out["k"] = node.key
        if node.children:
            out["c"] = [
                self.serialize(child, f"{path}/{child.key if child.key is not None else i}")
                for i, child in enumerate(node.children)
            ]
        return out

    def dispatch(self, cb_id, args_json):
        fn = self.callbacks.get(cb_id)
        if fn is None:
            return
        args = json.loads(args_json) if args_json else []
        self.dispatching = True
        try:
            result = _call(fn, args)
            if inspect.isawaitable(result):
                asyncio.ensure_future(_await_and_report(result))
        except Exception:
            traceback.print_exc()
        finally:
            self.dispatching = False
        if self.dirty:
            self.render()


def _call(fn, args):
    """Call fn with as many of args as it accepts (lambda: ... or def f(value): ...)."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return fn(*args)
    params = list(sig.parameters.values())
    if any(p.kind == p.VAR_POSITIONAL for p in params):
        return fn(*args)
    positional = [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    return fn(*args[: len(positional)])


async def _await_and_report(awaitable):
    try:
        await awaitable
    except Exception:
        traceback.print_exc()


_app = _App()


def run(view):
    """Show the UI described by ``view()`` and keep it updated."""
    if not callable(view):
        node = view
        view = lambda: node  # noqa: E731
    _app.run(view)
