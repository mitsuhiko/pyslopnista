# console — Alerts, output and system services

Alerts with buttons and text fields, colored output and links in the
console, a spinner, Quick Look previews and the "Open in…" menu.

```python
import console

console.set_color(0.2, 0.6, 1.0)
print("This is blue.")
console.set_color()

name = console.input_alert("What's your name?")
console.hud_alert(f"Hi {name}!")
```

The alerts block until answered. Their **Cancel** button raises
`KeyboardInterrupt`, which ends the program unless you catch it; pass
`hide_cancel_button=True` to leave it out. (The [dialogs](dialogs.html)
module's sheets return None instead.)

## Output

### console.clear()

Clear the console's output.

### console.set_color(r=None, g=None, b=None)

The color of the text printed after this, with components from 0.0 to 1.0;
no arguments go back to the default.

### console.set_font(name=None, size=None)

The console has one monospaced font; a name with "bold" in it prints bold,
anything else goes back to normal. Accepted for compatibility.

### console.write_link(title, link_url)

Print a tappable link.

### console.show_image(image_path)

Show an image file (PNG, JPEG, GIF, ...) in the console.

### console.hide_output()

Make room: the console shrinks to its title bar.

## Alerts

### console.alert(title, message='', button1=None, button2=None, button3=None, hide_cancel_button=False)

An alert with up to three buttons; returns 1, 2 or 3 for the one tapped.
Without buttons it shows OK.

```python
if console.alert("Save changes?", "", "Save", "Discard") == 1:
    save()
```

### console.input_alert(title, message='', input='', ok_button_title='OK', hide_cancel_button=False)

An alert with a text field, pre-filled with `input`; returns the text.

### console.password_alert(title, message='', password='', ok_button_title='OK', hide_cancel_button=False)

An alert with a hidden text field; returns the text.

### console.login_alert(title, message='', login='', password='', ok_button_title='Log In')

An alert with login and password fields; returns `(login, password)`.

### console.secure_input(prompt='')

Ask for text without showing it, like `input()` for passwords.

### console.hud_alert(message, icon='success', duration=1.8)

A brief message in the middle of the screen with a checkmark (`'success'`)
or a cross (`'error'`). Returns after `duration` seconds (0.25 to 5).

### console.show_activity()

Show a spinner at the top of the screen; it goes away when the program ends.

### console.hide_activity()

Hide the spinner.

## Files and system

### console.quicklook(file_path)

Preview a file full screen: images, PDF, text, CSV, Office and iWork
documents, audio and video. Pass a list to page through several. Returns
when the preview is closed.

### console.open_in(file_path)

The share sheet for a file: "Open in…" another app, AirDrop, Save to Files.
Returns the chosen activity, or None.

### console.set_idle_timer_disabled(flag)

`True` keeps the screen on while the app is open; `False` lets it sleep
again. Reset when the next program starts.

### console.is_in_background()

Whether the app is in the background.
