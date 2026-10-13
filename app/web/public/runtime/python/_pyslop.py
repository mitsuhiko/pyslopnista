"""Runtime support for Pyslopnista (installed into /lib/pyslop at boot).

- inline matplotlib: ``plt.show()`` sends PNGs to the console
- ``repl(source)``: run console input in ``__main__`` with REPL semantics
"""

import ast
import base64
import importlib.abc
import importlib.machinery
import io
import sys

import _pyslophost


# -- inline matplotlib -----------------------------------------------------------

def _show(*args, **kwargs):
    import matplotlib.pyplot as plt

    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=144, bbox_inches="tight")
        _pyslophost.image(base64.b64encode(buf.getvalue()).decode("ascii"))
    plt.close("all")


class _PyplotHook(importlib.abc.MetaPathFinder):
    """Patches matplotlib.pyplot.show once pyplot is imported."""

    def find_spec(self, name, path, target=None):
        if name != "matplotlib.pyplot":
            return None
        sys.meta_path.remove(self)
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None:
            return None
        loader = spec.loader
        original_exec = loader.exec_module

        def exec_module(module):
            import matplotlib

            matplotlib.use("agg")
            original_exec(module)
            module.show = _show

        loader.exec_module = exec_module
        return spec


sys.meta_path.insert(0, _PyplotHook())


# -- console ------------------------------------------------------------------------

async def repl(source):
    """Run source in __main__: show the value of a final expression like the REPL."""
    import __main__

    namespace = __main__.__dict__
    tree = ast.parse(source, "<console>", "exec")
    last_expr = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    if tree.body:
        result = eval(compile(tree, "<console>", "exec", flags=flags), namespace)
        if hasattr(result, "__await__"):
            await result
    if last_expr is not None:
        value = eval(compile(last_expr, "<console>", "eval", flags=flags), namespace)
        if hasattr(value, "__await__") and type(value).__name__ == "coroutine":
            value = await value
        if value is not None:
            namespace["_"] = value
            print(repr(value))
