import ui

todos = ui.state([
    {"id": 1, "title": "Learn Python", "done": True},
    {"id": 2, "title": "Build an app", "done": False},
])
draft = ui.state("")
next_id = 3


def add():
    global next_id
    title = draft.value.strip()
    if title:
        todos.set(todos.value + [{"id": next_id, "title": title, "done": False}])
        next_id += 1
        draft.set("")


def toggle(todo_id):
    todos.set([{**t, "done": not t["done"]} if t["id"] == todo_id else t for t in todos.value])


def delete(todo_id):
    todos.set([t for t in todos.value if t["id"] != todo_id])


def view():
    open_count = sum(not t["done"] for t in todos.value)
    return ui.Screen(
        "Todos",
        ui.Section(
            ui.TextField(draft.value, placeholder="What needs doing?", on_change=draft.set, on_submit=lambda _: add()),
            ui.Button("Add", on_tap=add, disabled=not draft.value.strip()),
        ),
        ui.Section(
            [
                ui.Row(
                    t["title"],
                    checked=t["done"],
                    on_tap=lambda t=t: toggle(t["id"]),
                    on_delete=lambda t=t: delete(t["id"]),
                    key=t["id"],
                )
                for t in todos.value
            ],
            header="Tasks",
            footer=f"{open_count} open",
        ),
    )


ui.run(view)
