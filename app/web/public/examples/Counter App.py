# A small app with buttons. Tap Done to close it.
import ui

count = ui.state(0)


def view():
    return ui.Screen(
        "Counter",
        ui.Text(f"{count.value}", style="largeTitle"),
        ui.HStack(
            ui.Button("−1", on_tap=lambda: count.update(lambda n: n - 1), style="tinted"),
            ui.Button("+1", on_tap=lambda: count.update(lambda n: n + 1)),
            ui.Button("Reset", on_tap=lambda: count.set(0), style="plain"),
        ),
    )


ui.run(view)
