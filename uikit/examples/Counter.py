# The smallest app: a signal, a computed value and two buttons.
# Components run once; the lambdas are what update when `count` changes.
import ui


def Counter():
    count = ui.signal(0)
    doubled = ui.computed(lambda: count() * 2)

    return ui.Screen(
        "Counter",
        ui.Text(lambda: f"{count()}", font="largeTitle", text_align="center"),
        ui.Text(lambda: f"doubled: {doubled()}", font="footnote", text_align="center"),
        ui.HStack(
            ui.Button("−1", on_click=lambda: count.update(lambda n: n - 1), kind="tinted", flex=1),
            ui.Button("+1", on_click=lambda: count.update(lambda n: n + 1), flex=1),
        ),
        ui.Button("Reset", on_click=lambda: count.set(0), kind="plain",
                  disabled=lambda: count() == 0),
    )


ui.run(Counter)
