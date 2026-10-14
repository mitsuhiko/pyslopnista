# A complete to-do app in the style of Reminders: lists, smart lists (Today,
# Overdue, All, Done), search, filters, sorting, due dates, priorities and
# notes. Everything is saved in an SQLite database, todos.db, next to this file.
#
# How it works: all data lives in one ui.store. Screens are plain functions
# that run once; the lambdas in them are what update when the data changes.
# An effect writes the store into the database whenever it changed.
import datetime
import json
import os
import sqlite3

import ui

DB_FILE = "todos.db"
COLORS = ["#007aff", "#ff9500", "#34c759", "#ff2d55", "#af52de", "#5ac8fa", "#ffcc00"]
PRIORITIES = {0: "None", 1: "Low", 2: "Medium", 3: "High"}


# -- data ------------------------------------------------------------------------

def today() -> str:
    return datetime.date.today().isoformat()


def initial_data():
    tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    return {
        "next_id": 7,
        "lists": [
            {"id": 1, "name": "Inbox", "color": "#007aff", "icon": "list"},
            {"id": 2, "name": "Groceries", "color": "#34c759", "icon": "cart"},
            {"id": 3, "name": "Learning", "color": "#ff9500", "icon": "star"},
        ],
        "todos": [
            {"id": 1, "list": 1, "title": "Try this app", "notes": "Tap the circle to finish a to-do.",
             "done": True, "due": today(), "priority": 0},
            {"id": 2, "list": 1, "title": "Swipe left to delete", "notes": "", "done": False, "due": None,
             "priority": 0},
            {"id": 3, "list": 2, "title": "Oat milk", "notes": "", "done": False, "due": today(), "priority": 2},
            {"id": 4, "list": 2, "title": "Coffee beans", "notes": "", "done": False, "due": None, "priority": 0},
            {"id": 5, "list": 3, "title": "Read about signals", "notes": "ui.signal, ui.computed, ui.effect",
             "done": False, "due": tomorrow, "priority": 3},
            {"id": 6, "list": 3, "title": "Build my own app", "notes": "", "done": False, "due": None,
             "priority": 1},
        ],
    }


db = sqlite3.connect(DB_FILE)
db.row_factory = sqlite3.Row
db.executescript("""
    CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        icon TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY,
        list INTEGER NOT NULL REFERENCES lists (id),
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0,
        due TEXT,  -- an ISO date (YYYY-MM-DD) or NULL
        priority INTEGER NOT NULL DEFAULT 0
    );
""")


def load():
    lists = [dict(row) for row in db.execute("SELECT * FROM lists ORDER BY id")]
    if not lists:
        # A new database: start with the to-dos an older version of this app
        # saved in todos.json, or with a few examples.
        if os.path.exists("todos.json"):
            with open("todos.json") as f:
                return json.load(f)
        return initial_data()
    todos = [dict(row, done=bool(row["done"])) for row in db.execute("SELECT * FROM todos ORDER BY id")]
    next_id = db.execute("SELECT max(id) FROM (SELECT id FROM lists UNION SELECT id FROM todos)").fetchone()[0]
    return {"next_id": next_id + 1, "lists": lists, "todos": todos}


data = ui.store(load())


def save(snapshot):
    # One transaction (`with db`): either all of it is saved or nothing. Rows
    # are upserted and the ones that are gone deleted, which is plenty fast
    # for a few thousand to-dos.
    with db:
        db.executemany(
            "INSERT OR REPLACE INTO lists (id, name, color, icon) VALUES (:id, :name, :color, :icon)",
            snapshot["lists"],
        )
        db.executemany(
            "INSERT OR REPLACE INTO todos (id, list, title, notes, done, due, priority)"
            " VALUES (:id, :list, :title, :notes, :done, :due, :priority)",
            snapshot["todos"],
        )
        for table in ("lists", "todos"):
            ids = [row["id"] for row in snapshot[table]]
            db.execute(f"DELETE FROM {table} WHERE id NOT IN ({', '.join('?' * len(ids))})", ids)


# ui.unwrap reads everything, so this effect runs after any change. The
# timeout belongs to the effect: a newer change cancels it, so saving waits
# until things are quiet for half a second. The app writes todos.db back into
# your files within a second after that, even while it keeps running.
@ui.effect
def autosave():
    snapshot = ui.unwrap(data)
    ui.timeout(0.5, lambda: save(snapshot))


def new_id() -> int:
    data.next_id += 1
    return data.next_id - 1


def list_by_id(list_id):
    return next((lst for lst in data.lists if lst.id == list_id), None)


def is_overdue(todo) -> bool:
    return bool(todo.due) and todo.due < today() and not todo.done


def due_label(todo) -> str:
    if not todo.due:
        return ""
    due = datetime.date.fromisoformat(todo.due)
    days = (due - datetime.date.today()).days
    if days == 0:
        return "Today"
    if days == 1:
        return "Tomorrow"
    if days == -1:
        return "Yesterday"
    return due.strftime("%a, %d %b")


# -- to-do details ------------------------------------------------------------------

def TodoDetail(todo):
    nav = ui.navigation()

    async def delete():
        if await ui.confirm(f"Delete “{todo.title}”?", destructive=True, ok="Delete"):
            data.todos.remove(todo)
            nav.pop()

    def set_due(on):
        todo.due = today() if on else None

    return ui.Screen(
        lambda: todo.title or "To-Do",
        ui.Section(
            ui.TextField(ui.bind(todo, "title"), placeholder="Title"),
            ui.TextArea(ui.bind(todo, "notes"), placeholder="Notes", rows=3),
        ),
        ui.Section(
            ui.Toggle("Completed", ui.bind(todo, "done")),
            ui.Toggle("Due date", lambda: todo.due is not None, on_change=set_due),
            ui.Show(lambda: todo.due, ui.DatePicker(
                lambda: datetime.date.fromisoformat(todo.due) if todo.due else None,
                on_change=lambda d: setattr(todo, "due", d.isoformat() if d else None),
                label="Date",
            )),
            ui.Picker(PRIORITIES, ui.bind(todo, "priority"), kind="menu", label="Priority"),
            ui.Picker(lambda: {lst.id: lst.name for lst in data.lists}, ui.bind(todo, "list"),
                      kind="menu", label="List"),
        ),
        ui.Section(ui.Button("Delete To-Do", on_click=delete, kind="destructive")),
        large_title=False,
    )


# -- a list of to-dos -------------------------------------------------------------------

SORTS = ["Manual", "Due Date", "Priority", "Title"]


def sort_key(how):
    if how == "Due Date":
        return lambda t: (t.due is None, t.due or "")
    if how == "Priority":
        return lambda t: -t.priority
    if how == "Title":
        return lambda t: t.title.lower()
    return lambda t: t.id


def TodoRow(todo):
    def subtitle():
        parts = []
        if is_overdue(todo):
            parts.append("⚠️ " + due_label(todo))
        elif todo.due:
            parts.append(due_label(todo))
        if todo.notes:
            parts.append(todo.notes.splitlines()[0])
        return " · ".join(parts)

    return ui.Row(
        lambda: todo.title or "New To-Do",
        subtitle=subtitle,
        detail=lambda: "!" * todo.priority,
        checked=lambda: todo.done,
        on_check=lambda: setattr(todo, "done", not todo.done),
        on_click=lambda: ui.navigation().push(TodoDetail, todo),
        on_delete=lambda: data.todos.remove(todo),
    )


def TodoList(title, matches, *, list_id=None, color="#007aff", new_due=None):
    """A screen of the to-dos for which ``matches(todo)`` is true. With
    ``list_id``, new to-dos can be added there."""
    draft = ui.signal("")
    query = ui.signal("")
    show = ui.signal("Open")
    sort = ui.signal("Manual")

    mine = ui.computed(lambda: [t for t in data.todos if matches(t)])
    open_count = ui.computed(lambda: sum(not t.done for t in mine()))

    def visible():
        q = query().strip().lower()
        items = [
            t for t in mine()
            if (show() == "All" or t.done == (show() == "Done"))
            and (not q or q in t.title.lower() or q in t.notes.lower())
        ]
        return sorted(items, key=sort_key(sort()))

    def add():
        text = draft().strip()
        if text:
            data.todos.append({"id": new_id(), "list": list_id or 1, "title": text, "notes": "",
                               "done": False, "due": new_due, "priority": 0})
            draft.set("")
            show.set("Open" if show() == "Done" else show())

    async def menu():
        choice = await ui.choose(None, [f"Sort by {s}" for s in SORTS] + ["Clear Completed"])
        if choice is None:
            return
        if choice == "Clear Completed":
            done = [t for t in mine() if t.done]
            if not done:
                ui.toast("Nothing to clear")
            elif await ui.confirm(f"Delete {len(done)} completed to-dos?", destructive=True, ok="Delete"):
                data.todos.set([t for t in data.todos if t not in done])
        else:
            sort.set(choice.removeprefix("Sort by "))

    can_add = list_id is not None or new_due is not None
    return ui.Screen(
        title,
        ui.Section(
            ui.HStack(
                ui.Icon("plus", size=22, color=color),
                ui.TextField(draft, placeholder="New To-Do", on_submit=add, flex=1),
                ui.Button("Add", on_click=add, kind="plain", hidden=lambda: not draft().strip()),
                spacing=10,
            ),
        ) if can_add else None,
        ui.TextField(query, kind="search", placeholder="Search"),
        ui.Picker(["Open", "Done", "All"], show),
        ui.Section(
            ui.For(visible, TodoRow, fallback=ui.Row(lambda: "No matches" if query() else "Nothing here",
                                                     subtitle="Add a to-do above" if list_id else None)),
            footer=lambda: f"{open_count()} open · sorted by {sort().lower()}",
        ),
        trailing=ui.Button(icon="ellipsis", on_click=menu, aria_label="More"),
    )


# -- home -----------------------------------------------------------------------------------

def SmartCard(title, icon, color, count, open_screen):
    return ui.Card(
        ui.HStack(
            ui.Icon(icon, size=26, color=color),
            ui.Spacer(),
            ui.Text(lambda: str(count()), font="title2"),
        ),
        ui.Text(title, font="subheadline", color="secondary", font_weight="semibold"),
        padding=12,
        spacing=6,
        on_click=lambda: ui.navigation().push(open_screen),
    )


def ListRow(lst):
    open_count = ui.computed(lambda: sum(t.list == lst.id and not t.done for t in data.todos))

    async def delete():
        n = sum(t.list == lst.id for t in data.todos)
        if lst.id == 1:
            ui.toast("The Inbox can't be deleted")
        elif await ui.confirm(f"Delete “{lst.name}”?", f"This also deletes its {n} to-dos." if n else None,
                              destructive=True, ok="Delete"):
            data.todos.set([t for t in data.todos if t.list != lst.id])
            data.lists.remove(lst)

    def open_list():
        ui.navigation().push(lambda: TodoList(lst.name, lambda t: t.list == lst.id, list_id=lst.id,
                                              color=lst.color))

    return ui.Row(
        lambda: lst.name,
        icon=lambda: lst.icon,
        detail=open_count,
        accessory="chevron",
        on_click=open_list,
        on_delete=delete,
        tint=lambda: lst.color,
    )


def Home():
    def count(pred):
        return ui.computed(lambda: sum(1 for t in data.todos if pred(t)))

    today_count = count(lambda t: t.due == today() and not t.done)
    overdue_count = count(is_overdue)
    all_count = count(lambda t: not t.done)
    done_count = count(lambda t: t.done)

    async def new_list():
        name = await ui.prompt("New List", placeholder="Name")
        if name and name.strip():
            data.lists.append({"id": new_id(), "name": name.strip(),
                               "color": COLORS[len(data.lists) % len(COLORS)], "icon": "list"})

    return ui.Screen(
        "Reminders",
        ui.Grid(
            SmartCard("Today", "calendar", "#007aff", today_count,
                      lambda: TodoList("Today", lambda t: t.due == today(), new_due=today())),
            SmartCard("Overdue", "clock", "#ff3b30", overdue_count,
                      lambda: TodoList("Overdue", is_overdue, color="#ff3b30")),
            SmartCard("All", "list", "#5856d6", all_count,
                      lambda: TodoList("All", lambda t: True)),
            SmartCard("Completed", "checkmark.circle", "#8e8e93", done_count,
                      lambda: TodoList("Completed", lambda t: t.done)),
            columns=2,
            spacing=12,
        ),
        ui.Section(
            ui.For(data.lists, ListRow),
            header="My Lists",
            footer="Swipe a list to delete it.",
        ),
        trailing=ui.Button(icon="plus", on_click=new_list, aria_label="New List"),
    )


ui.run(ui.NavigationStack(Home))
