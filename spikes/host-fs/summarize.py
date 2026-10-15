"""Print run.sh's JSON as tables: ms (host round trips) per workload and mount."""
import json
import sys

data = json.load(open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin)
if "transport" in data:
    t = data["transport"]
    print("transport (ms per call)      " + "  ".join(f"{k:>8}" for k in t))
    for key in next(iter(t.values())):
        print(f"  {key:<26} " + "  ".join(f"{t[k][key]:8.3f}" for k in t))
py = data.get("python", {})
mounts = list(py)
groups = [g for g in py.get("mem", {}) if g != "wal"]
for group in groups:
    print(f"\n{group}" + "".join(f"{m:>16}" for m in mounts))
    for name, r in py["mem"][group].items():
        if not isinstance(r, dict):
            continue
        cells = []
        for m in mounts:
            x = py[m][group][name]
            cells.append(f"{x['ms']:>8.1f}" + (f" ({x['calls']:>4})" if "calls" in x else "       "))
        print(f"  {name:<22}" + "".join(f"{c:>16}" for c in cells))
for key in ("check", "copy", "crash"):
    if key in data:
        print(f"\n{key}: {json.dumps(data[key])}")
if "wal" in py.get("mem", {}):
    print("\nwal: " + json.dumps({m: py[m]["wal"] for m in mounts}))
