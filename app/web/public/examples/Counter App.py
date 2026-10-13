# A small app with buttons. Tap Done to close it.
#
# Components run once. `count` is a signal: the lambdas that read it are
# what update on screen when it changes.
import ui


def Counter():
    count = ui.signal(0)

    return ui.Screen(
        "Counter",
        ui.Text(lambda: f"{count()}", font="largeTitle", text_align="center", font_size=64),
        ui.Text(lambda: "even" if count() % 2 == 0 else "odd", font="footnote", text_align="center"),
        ui.HStack(
            ui.Button("−1", on_click=lambda: count.update(lambda n: n - 1), kind="tinted", flex=1),
            ui.Button("+1", on_click=lambda: count.update(lambda n: n + 1), flex=1),
        ),
        ui.Button("Reset", on_click=lambda: count.set(0), kind="plain", disabled=lambda: count() == 0),
    )


ui.run(Counter)
