# A spirit level with a map: lay the phone flat and center the bubble.
#
# Uses motion (the tilt, read every frame), haptics (a tick when it is
# level) and location (where you are, with a map). Tap Done to close it.
import math

import haptics
import location
import motion
import ui


def tilt(g):
    return math.degrees(math.asin(max(-1.0, min(1.0, g))))


def Level():
    gx = ui.signal(0.0)
    gy = ui.signal(0.0)
    level = ui.computed(lambda: abs(tilt(gx())) < 1 and abs(tilt(gy())) < 1)
    place = ui.signal("")
    picture = ui.signal(None)
    state = {"level": False}

    motion.start_updates()
    ui.on_cleanup(motion.stop_updates)

    def frame(dt):
        x, y, _ = motion.get_gravity()
        with ui.batch():  # smoothed, so the bubble doesn't jitter
            gx.set(gx.peek() * 0.8 + x * 0.2)
            gy.set(gy.peek() * 0.8 + y * 0.2)
        now = level.peek()
        if now and not state["level"]:
            haptics.impact("rigid")
        state["level"] = now

    def draw(p):
        p.clear("#11161f")
        for r in (130, 80, 22):
            p.circle(150, 150, r, stroke="#34404f", width=2)
        p.line(150, 10, 150, 290, color="#232c38")
        p.line(10, 150, 290, 150, color="#232c38")
        x = 150 + max(-1, min(1, gx() * 4)) * 120
        y = 150 - max(-1, min(1, gy() * 4)) * 120
        p.circle(x, y, 18, fill="#35d07f" if level() else "#ffd43b")

    def where():
        location.start_updates()
        here = location.get_location()
        location.stop_updates()
        if not here:
            place.set("No location (allow it in Settings)")
            return
        address = (location.reverse_geocode(here) or [{}])[0]
        place.set(", ".join(v for v in (address.get("Name"), address.get("City"), address.get("Country")) if v)
                  or f"{here['latitude']:.4f}, {here['longitude']:.4f}")
        picture.set(location.render_map_snapshot(here["latitude"], here["longitude"], width=800, height=500,
                                                 img_width=600, img_height=360))

    return ui.Screen(
        "Level",
        ui.Canvas(draw, width=300, height=300, on_frame=frame, corner_radius=16),
        ui.Text(lambda: f"{tilt(gx()):+.1f}°   {tilt(gy()):+.1f}°", font="title2", mono=True, text_align="center",
                color=lambda: "green" if level() else "primary"),
        ui.Card(
            ui.Button("Where am I?", on_click=where, icon="location", kind="tinted"),
            ui.Show(place, lambda: ui.Text(place, font="headline")),
            ui.Show(picture, lambda: ui.Image(picture, corner_radius=12)),
        ),
    )


ui.run(Level)
