import asyncio
import time

import ui

started = time.monotonic()
elapsed = ui.state(0.0)
running = ui.state(True)


async def tick():
    while True:
        await asyncio.sleep(0.1)
        if running.value:
            elapsed.set(time.monotonic() - started)


def view():
    return ui.Screen(
        "Timer",
        ui.Text(f"{elapsed.value:.1f} s", style="largeTitle"),
        ui.Section(ui.Toggle("Running", running.value, on_change=running.set)),
    )


ui.run(view)
asyncio.ensure_future(tick())
