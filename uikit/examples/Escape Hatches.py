# Raw HTML elements, custom CSS and async data with ui.resource.
import asyncio

import ui

ui.css("""
.pill { display: inline-block; padding: 4px 10px; border-radius: 999px; background: var(--fill); }
.pill.on { background: var(--tint); color: white; }
""")


async def load_quote(n):
    await asyncio.sleep(0.4)  # pretend this is a network request
    return ["Simple is better than complex.", "Readability counts.", "Now is better than never."][n % 3]


def App():
    n = ui.signal(0)
    quote = ui.resource(load_quote, n)
    keys = ui.signal("")
    return ui.Screen(
        "Escape Hatches",
        ui.Card(
            ui.Show(quote.loading, ui.ProgressView(), fallback=ui.Text(lambda: quote() or "", font="title3")),
            ui.Button("Next quote", on_click=lambda: n.update(lambda v: v + 1), kind="tinted"),
        ),
        ui.h("div",
             ui.h("span", "h() pill", class_=lambda: "pill on" if n() % 2 else "pill"),
             " and ",
             ui.h("b", lambda: f"{n()} clicks"),
             style={"display": "flex", "gap": 8, "align_items": "center"}),
        ui.h("input", placeholder="Type here (raw <input>)", on_keydown=lambda e: keys.update(lambda k: (k + e.key)[-20:]),
             style={"padding": 10, "border_radius": 10, "border": "1px solid var(--separator)", "font": "inherit"}),
        ui.Text(lambda: f"Last keys: {keys()}", mono=True, font="footnote"),
        ui.Html("<p>Raw <em>HTML</em> works too, with <a href='https://pyodide.org'>links</a>.</p>"),
        ui.h("svg", ui.h("circle", cx=50, cy=50, r=lambda: 20 + (n() % 5) * 6, fill="var(--tint)"),
             viewBox="0 0 100 100", width=100, height=100),
    )


ui.run(App)
