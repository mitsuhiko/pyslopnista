# dialogs — Ready-made dialogs

Dialogs for simple input that need no UI code: pick from a list, fill in a
form, edit text, choose a date, share something, or import a file.

```python
import dialogs

fruit = dialogs.list_dialog("Pick a fruit", ["Apple", "Banana", "Cherry"])
info = dialogs.form_dialog("Sign up", [
    {"type": "text", "key": "name", "title": "Name"},
    {"type": "email", "key": "email", "title": "Email"},
    {"type": "switch", "key": "news", "title": "Newsletter", "value": True},
])
if info:
    print(info["name"], info["news"])
```

Each function blocks until the dialog is closed. Cancelled dialogs return
None. The alerts from [console](console.html) are here too (`alert`,
`input_alert`, `password_alert`, `login_alert`, `hud_alert`).

## Lists

### dialogs.list_dialog(title='', items=None, multiple=False)

Pick an item from a list, or several with `multiple=True` (then a list is
returned). Items can be any objects; they are shown with `str()`, or a
dict's `'title'`.

### dialogs.edit_list_dialog(title='', items=None, move=True, delete=True)

Let the user reorder (`move`) and remove (`delete`) items; returns the new
list.

## Forms

### dialogs.form_dialog(title='', fields=None, sections=None)

A form like a settings screen; returns a dict with each field's value by
its key.

Each field is a dict:

| Key | Meaning |
|---|---|
| `type` | `'text'`, `'url'`, `'email'`, `'password'`, `'number'`, `'switch'`, `'check'`, `'date'`, `'time'` or `'datetime'` (required) |
| `key` | the key in the result (default: the title) |
| `title` | the label |
| `value` | the starting value: a string, `True`/`False` for switches and checks, a `datetime` for dates |
| `placeholder` | the hint in an empty text field |

Text fields return strings (also `'number'`), switches and checks booleans,
dates `datetime.datetime` objects. For several groups, pass `sections`: a
list of `(title, fields)` or `(title, fields, footer)`.

## Text and dates

### dialogs.text_dialog(title='', text='', font=('<system>', 16), autocorrection=None, autocapitalization=None, spellchecking=None)

A full-screen text editor; returns the edited text. A font name with
"mono" in it uses a monospaced font.

### dialogs.date_dialog(title='')

Pick a date; returns a `datetime.datetime` at midnight.

### dialogs.time_dialog(title='')

Pick a time of day; returns a `datetime.datetime` today.

### dialogs.datetime_dialog(title='')

Pick a date and time; returns a `datetime.datetime`.

### dialogs.duration_dialog(title='')

Pick hours and minutes, e.g. for a timer; returns seconds as a float.

## Sharing and files

### dialogs.share_text(text)

The share sheet for text (Messages, Mail, Notes, Copy, ...). Returns the
chosen activity, or None.

### dialogs.share_url(url)

The share sheet for a link.

### dialogs.share_image(img)

The share sheet for an image: a PIL image, image bytes or a file path.

### dialogs.pick_document(types=('public.data',))

The document picker (Files, iCloud Drive, other apps). Returns the path of
a copy you can read, or None. `types` are Uniform Type Identifiers, e.g.
`['public.image']`, `['public.comma-separated-values-text']` or
`['public.plain-text']`.
