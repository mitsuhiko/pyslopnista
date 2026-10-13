import ui

size = ui.state(24.0)
bold = ui.state(False)
name = ui.state("World")


def view():
    return ui.Screen(
        "Widgets",
        ui.Section(
            ui.TextField(name.value, placeholder="Name", on_change=name.set),
            ui.Toggle("Shout", bold.value, on_change=bold.set),
            ui.Slider(size.value, min=12, max=48, step=1, on_change=size.set),
            header="Controls",
            footer=f"Font size {size.value:.0f}",
        ),
        ui.Section(
            ui.Row("Greeting", detail=(f"Hello, {name.value}" + ("!" if bold.value else "."))),
            ui.Row("Characters", detail=str(len(name.value))),
            header="Result",
        ),
        ui.Text(f"Hello, {name.value}" + ("!" if bold.value else "."), style="title" if bold.value else "body"),
    )


ui.run(view)
