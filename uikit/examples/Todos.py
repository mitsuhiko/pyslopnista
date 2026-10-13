# A todo list with a store: changing one todo only updates its own row.
import ui

todos = ui.store([
    {"title": "Learn Python", "done": True},
    {"title": "Build an app", "done": False},
    {"title": "Publish it", "done": False},
])


def TodoRow(todo):
    return ui.Row(
        lambda: todo.title,
        checked=lambda: todo.done,
        on_click=lambda: setattr(todo, "done", not todo.done),
        on_delete=lambda: todos.remove(todo),
    )


def App():
    draft = ui.signal("")
    show = ui.signal("All")
    remaining = ui.computed(lambda: sum(not t.done for t in todos))

    def add():
        if draft().strip():
            todos.append({"title": draft().strip(), "done": False})
            draft.set("")

    def visible():
        if show() == "Open":
            return [t for t in todos if not t.done]
        if show() == "Done":
            return [t for t in todos if t.done]
        return todos

    async def clear_done():
        if await ui.confirm("Remove finished todos?", destructive=True, ok="Remove"):
            todos.set([t for t in todos if not t.done])

    return ui.Screen(
        "Todos",
        ui.Section(
            ui.TextField(draft, placeholder="What needs doing?", on_submit=add),
            ui.Button("Add", on_click=add, disabled=lambda: not draft().strip()),
        ),
        ui.Picker(["All", "Open", "Done"], show),
        ui.Section(
            ui.For(visible, TodoRow, fallback=ui.Row("Nothing here")),
            footer=lambda: f"{remaining()} of {len(todos)} left · swipe a row to delete",
        ),
        trailing=ui.Button("Clear", on_click=clear_done, disabled=lambda: remaining() == len(todos)),
    )


ui.run(App)
