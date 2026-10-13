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


# -- dependencies (PEP 723 inline script metadata, pyproject.toml) ----------------

import os
import re

_SCRIPT_BLOCK = re.compile(
    r"(?m)^# /// (?P<type>[a-zA-Z0-9-]+)$\s(?P<content>(^#(| .*)$\s)+)^# ///$"
)


def read_script_metadata(source):
    """Return the parsed ``# /// script`` block (PEP 723 reference algorithm) or None."""
    import tomllib

    matches = [m for m in _SCRIPT_BLOCK.finditer(source) if m.group("type") == "script"]
    if len(matches) > 1:
        raise ValueError("multiple '# /// script' blocks found")
    if not matches:
        return None
    content = "".join(
        line[2:] if line.startswith("# ") else line[1:]
        for line in matches[0].group("content").splitlines(keepends=True)
    )
    return tomllib.loads(content)


def _project_metadata(cwd):
    import tomllib

    path = os.path.join(cwd, "pyproject.toml")
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        project = tomllib.load(f).get("project", {})
    return {"dependencies": project.get("dependencies", []), "requires-python": project.get("requires-python")}


class DependencyError(Exception):
    pass


async def prepare_environment(source, cwd, index_url):
    """Install the dependencies declared by the script (or pyproject.toml)."""
    try:
        meta = read_script_metadata(source)
        origin = "script metadata"
        if meta is None:
            meta = _project_metadata(cwd)
            origin = "pyproject.toml"
    except Exception as e:
        raise DependencyError(f"could not read the dependency metadata: {e}") from None
    if not meta:
        return

    import pyodide_js

    # packaging is needed for the requires-python check (micropip vendors its own copy).
    await pyodide_js.loadPackage(["micropip", "packaging"])
    _allow_app_scheme()

    requires = meta.get("requires-python")
    if requires:
        from packaging.specifiers import SpecifierSet

        here = ".".join(map(str, sys.version_info[:3]))
        if here not in SpecifierSet(requires):
            raise DependencyError(f"this program requires Python {requires} ({origin}), but this is Python {here}")

    deps = [d for d in meta.get("dependencies", []) if d.strip()]
    if not deps:
        return

    import micropip

    before = {name: pkg.version for name, pkg in micropip.list().items()}
    _pyslophost.status(f"Installing {', '.join(deps)} …")
    try:
        await micropip.install(deps, keep_going=True, index_urls=[index_url])
    except Exception as e:
        raise DependencyError(f"could not install dependencies ({origin}):\n{e}") from None
    after = micropip.list()
    added = sorted(f"{name} {pkg.version}" for name, pkg in after.items() if name not in before)
    if added:
        _pyslophost.status(f"Installed {', '.join(added)}")


def _allow_app_scheme():
    """micropip only downloads http(s)/file URLs; our cached index serves app:// URLs."""
    from micropip import wheelinfo

    if getattr(wheelinfo.WheelInfo, "_pyslop_patched", False):
        return
    original = wheelinfo.WheelInfo._fetch_bytes

    async def _fetch_bytes(self, url, fetch_kwargs, compat_layer):
        if self.parsed_url.scheme == "app":
            return await compat_layer.fetch_bytes(url, fetch_kwargs)
        return await original(self, url, fetch_kwargs, compat_layer)

    wheelinfo.WheelInfo._fetch_bytes = _fetch_bytes
    wheelinfo.WheelInfo._pyslop_patched = True
