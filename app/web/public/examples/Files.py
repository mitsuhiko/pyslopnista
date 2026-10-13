# Programs can read and write files next to them.
# After running, notes.txt appears in the file browser.
from datetime import datetime

with open("notes.txt", "a") as f:
    f.write(f"Ran at {datetime.now():%Y-%m-%d %H:%M:%S}\n")

with open("notes.txt") as f:
    print(f.read())
