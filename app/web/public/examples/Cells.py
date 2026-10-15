# A script with cells: each "# %%" starts one. Tap ▶ on a cell to run
# it (or Shift-Return); its output shows below it, and what it defines stays
# for the next cells. Run (above) still runs the whole file as a script.

# %%
import random

rolls = [random.randint(1, 6) for _ in range(1000)]
len(rolls)

# %%
from collections import Counter

counts = Counter(rolls)
for face in range(1, 7):
    print(face, "#" * (counts[face] // 10))

# %% [markdown]
# ## Charts
# A plot shows below its cell, without `plt.show()`.

# %%
import matplotlib.pyplot as plt

plt.bar(list(counts), list(counts.values()))
plt.title("1000 rolls of a die");
