# /// script
# dependencies = [
#     "humanize",
# ]
# ///
# Packages from PyPI are declared in a block like the one above
# (PEP 723, the same format `uv run` understands). They are
# installed when you run the program and cached for offline use.
#
# Tip: write `import something` and tap the fix in the problem bar
# to add it here automatically.
import datetime

import humanize

print(humanize.naturalsize(3_500_000))
print(humanize.intword(12_400_000_000))
print(humanize.naturaltime(datetime.timedelta(minutes=42)))
