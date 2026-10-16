"""subprocess for Python programs."""
import subprocess
import sys

from _check import check, metric, report, timed

if __name__ == "__main__":
    with timed() as t:
        r = subprocess.run([sys.executable, "-c", "print(6 * 7)"], capture_output=True, text=True)
    check("run -c, capture stdout", r.returncode == 0 and r.stdout == "42\n", (r.returncode, r.stdout, r.stderr))
    metric("subprocess.run round trip ms", t.ms)

    out = subprocess.check_output(["python3", "-c", "import sys; print(sys.argv[1:])", "a", "b"], text=True)
    check("python3 by name, argv", out == "['a', 'b']\n", out)

    r = subprocess.run([sys.executable, "-c", "import sys; print(sys.stdin.read().upper(), end='')"],
                       input="hello pipes", capture_output=True, text=True)
    check("stdin -> stdout", r.stdout == "HELLO PIPES", r.stdout)

    r = subprocess.run([sys.executable, "-c", "import sys; sys.exit(5)"])
    check("exit code", r.returncode == 5, r.returncode)

    try:
        subprocess.run([sys.executable, "-c", "raise SystemExit(2)"], check=True)
        check("check=True raises", False, "no error")
    except subprocess.CalledProcessError as e:
        check("check=True raises", e.returncode == 2, e.returncode)

    r = subprocess.run([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); 1/0"],
                       capture_output=True, text=True)
    check("stderr captured, exception -> 1", r.returncode == 1 and "ZeroDivisionError" in r.stderr and r.stdout == "out\n",
          (r.returncode, r.stdout, r.stderr[-200:]))

    r = subprocess.run([sys.executable, "-c", "import sys; print('a'); print('b', file=sys.stderr)"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    check("stderr=STDOUT", sorted(r.stdout.split()) == ["a", "b"], r.stdout)

    r = subprocess.run([sys.executable, "-m", "json.tool"], input='{"b": 1, "a": [1, 2]}', capture_output=True, text=True)
    check("-m json.tool", r.returncode == 0 and '"a": [' in r.stdout, (r.returncode, r.stdout, r.stderr[-300:]))

    # helper_script.py is one of the project's files (each worker has its own
    # MEMFS here; in the app they all mount the same folder, D35).
    out = subprocess.check_output([sys.executable, "helper_script.py", "x"], text=True)
    check("script file, cwd inherited", out == "helper_script.py ['x'] /home/pyodide/project\n", out)

    r = subprocess.run([sys.executable, "-c", "import os; print(os.environ.get('SPIKE'))"],
                       env={"SPIKE": "yes"}, capture_output=True, text=True)
    check("env", r.stdout == "yes\n", r.stdout)

    try:
        subprocess.run([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.5)
        check("timeout kills", False, "no error")
    except subprocess.TimeoutExpired:
        check("timeout kills", True)

    p = subprocess.Popen([sys.executable, "-c", "for i in range(5): print(i, flush=True)"],
                         stdout=subprocess.PIPE, text=True)
    lines = [line.strip() for line in p.stdout]
    p.wait()
    check("Popen, iterate stdout", lines == ["0", "1", "2", "3", "4"] and p.returncode == 0, (lines, p.returncode))

    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    p.terminate()
    check("Popen.terminate", p.wait(10) == -15, p.returncode)

    p = subprocess.Popen([sys.executable, "-c", "import time\ntry:\n    time.sleep(30)\nexcept KeyboardInterrupt:\n    print('caught')\n"],
                         stdout=subprocess.PIPE, text=True)
    import time
    time.sleep(1.0)
    import signal
    p.send_signal(signal.SIGINT)
    out, _ = p.communicate(timeout=10)
    check("SIGINT -> KeyboardInterrupt in the child", out == "caught\n", out)

    nested = subprocess.run([sys.executable, "-c",
                             "import subprocess, sys; print(subprocess.check_output([sys.executable, '-c', 'print(1+1)'], text=True), end='')"],
                            capture_output=True, text=True)
    check("subprocess of a subprocess", nested.stdout == "2\n", (nested.stdout, nested.stderr[-300:]))

    r = subprocess.run([sys.executable, "-c", "print('quiet')"], stdout=subprocess.DEVNULL)
    check("stdout=DEVNULL", r.returncode == 0)

    try:
        subprocess.run(["ls", "-l"])
        check("non-Python programs: FileNotFoundError", False, "no error")
    except FileNotFoundError as e:
        check("non-Python programs: FileNotFoundError", "only Python" in str(e), e)
    report()
