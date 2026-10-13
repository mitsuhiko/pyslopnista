import ui


def test_signal_effect(h):
    count = ui.signal(1)
    seen = []
    ui.effect(lambda: seen.append(count()))
    count.set(2)
    count.set(2)  # same immutable value: no update
    count.value += 1
    assert seen == [1, 2, 3]


def test_mutable_values_always_notify(h):
    items = ui.signal([1])
    seen = []
    ui.effect(lambda: seen.append(len(items())))
    items().append(2)
    items.set(items())
    assert seen == [1, 2]


def test_diamond_is_glitch_free(h):
    a = ui.signal(1)
    b = ui.computed(lambda: a() * 2)
    c = ui.computed(lambda: a() + 1)
    runs = []
    ui.effect(lambda: runs.append((b(), c())))
    a.set(5)
    assert runs == [(2, 2), (10, 6)]


def test_computed_is_lazy_and_cuts_off(h):
    calls = []
    a = ui.signal(1)

    @ui.computed
    def parity():
        calls.append(1)
        return a() % 2

    assert calls == []
    runs = []
    ui.effect(lambda: runs.append(parity()))
    a.set(3)  # parity unchanged: effect must not run
    assert runs == [1]
    a.set(4)
    assert runs == [1, 0]


def test_batch(h):
    a, b = ui.signal(1), ui.signal(2)
    runs = []
    ui.effect(lambda: runs.append(a() + b()))
    with ui.batch():
        a.set(10)
        b.set(20)
        assert a() == 10  # reads see new values inside the batch
    assert runs == [3, 30]


def test_untrack_and_peek(h):
    a, b = ui.signal(1), ui.signal(1)
    runs = []
    ui.effect(lambda: runs.append(a() + ui.untrack(b) + b.peek()))
    b.set(5)
    assert runs == [3]
    a.set(2)
    assert runs == [3, 12]


def test_nested_effects_are_disposed_on_rerun(h):
    outer = ui.signal(0)
    inner = ui.signal(0)
    log = []

    def parent():
        o = outer()
        ui.effect(lambda: log.append((o, inner())))
        ui.on_cleanup(lambda: log.append(("cleanup", o)))

    ui.effect(parent)
    outer.set(1)
    inner.set(7)
    assert log == [(0, 0), ("cleanup", 0), (1, 0), (1, 7)]


def test_effect_dispose(h):
    a = ui.signal(0)
    runs = []
    e = ui.effect(lambda: runs.append(a()))
    e.dispose()
    a.set(1)
    assert runs == [0]


def test_store_is_fine_grained(h):
    todos = ui.store([{"title": "a", "done": False}, {"title": "b", "done": False}])
    titles, dones = [], []
    ui.effect(lambda: titles.append([t.title for t in todos]))
    first = todos[0]
    ui.effect(lambda: dones.append(first.done))
    first.done = True
    assert dones == [False, True]
    assert titles == [["a", "b"]]  # titles did not re-run for a done change
    todos.append({"title": "c", "done": False})
    assert titles[-1] == ["a", "b", "c"]
    assert isinstance(todos[2], ui.ReactiveDict)
    assert ui.unwrap(todos)[2] == {"title": "c", "done": False}


def test_store_keys(h):
    s = ui.store(name="x")
    seen = []
    ui.effect(lambda: seen.append(sorted(s)))
    s["age"] = 3
    s.name = "y"  # existing key: no keys change
    del s["age"]
    assert seen == [["name"], ["age", "name"], ["name"]]


def test_list_remove_prefers_identity(h):
    a, b = {"x": 1}, {"x": 1}
    items = ui.store([a, b])
    second = items[1]
    items.remove(second)
    assert len(items) == 1 and items[0] is not second


def test_bind(h):
    todo = ui.store({"done": False})
    b = ui.bind(todo, "done")
    seen = []
    ui.effect(lambda: seen.append(b()))
    b.set(True)
    assert seen == [False, True] and todo.done is True


def test_signal_truthiness_is_an_error(h):
    flag = ui.signal(True)
    try:
        bool(flag)
    except TypeError as e:
        assert "flag()" in str(e)
    else:
        raise AssertionError("expected TypeError")


def test_signal_formats_its_value(h):
    n = ui.signal(3)
    assert f"{n} taps" == "3 taps"
    assert f"{n:03d}" == "003"


def test_effect_errors_are_reported_not_raised(h, capsys):
    a = ui.signal(0)
    ui.effect(lambda: 1 / a())
    a.set(1)
    assert "ZeroDivisionError" in capsys.readouterr().err


def test_runaway_effects_are_stopped(h):
    a, b = ui.signal(0), ui.signal(0)
    ui.effect(lambda: b.set(a() + 1))
    try:
        ui.effect(lambda: a.set(b() + 1))
    except RuntimeError as e:
        assert "keep triggering" in str(e)
    else:
        raise AssertionError("expected RuntimeError")


def test_unwrap_tracks_deeply_inside_effects(h):
    data = ui.store({"todos": [{"title": "a", "done": False}]})
    saved = []
    ui.effect(lambda: saved.append(ui.unwrap(data)))
    data.todos[0].done = True
    data.todos.append({"title": "b", "done": False})
    assert [len(s["todos"]) for s in saved] == [1, 1, 2]
    assert saved[1]["todos"][0]["done"] is True
