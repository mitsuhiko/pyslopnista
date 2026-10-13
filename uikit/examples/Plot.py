# A matplotlib figure that redraws when the slider moves.
import matplotlib.pyplot as plt
import numpy as np

import ui

freq = ui.signal(2.0)


def figure():
    fig, ax = plt.subplots(figsize=(5, 3))
    x = np.linspace(0, 2 * np.pi, 400)
    ax.plot(x, np.sin(freq() * x))
    ax.set_title(f"sin({freq():.1f}x)")
    plt.close(fig)
    return fig


ui.run(ui.Screen(
    "Plot",
    ui.Image(figure, corner_radius=12),
    ui.Section(ui.Slider(freq, min=0.5, max=8, label="Frequency")),
))
