"""Ready-made dialogs for simple input: lists, forms, text, dates, sharing and picking files.

    import dialogs
    fruit = dialogs.list_dialog("Pick a fruit", ["Apple", "Banana", "Cherry"])
    info = dialogs.form_dialog("Sign up", [
        {"type": "text", "key": "name", "title": "Name"},
        {"type": "switch", "key": "news", "title": "Newsletter", "value": True},
    ])

Cancelled dialogs return None (the alerts, as in console, raise KeyboardInterrupt).
"""

import datetime as _dt

from _device import call, image_payload, parse_datetime, temp_file
from console import alert, hud_alert, input_alert, login_alert, password_alert

__all__ = [
    "list_dialog", "edit_list_dialog", "form_dialog", "text_dialog", "date_dialog", "time_dialog",
    "datetime_dialog", "duration_dialog", "share_image", "share_text", "share_url", "pick_document",
    "alert", "input_alert", "login_alert", "password_alert", "hud_alert",
]


def _label(item):
    if isinstance(item, dict):
        return str(item.get("title", item))
    return str(item)


def list_dialog(title="", items=None, multiple=False):
    """Pick one item (or several, with multiple=True) from a list; None if cancelled."""
    items = list(items or [])
    picked = call("list", title=str(title), items=[_label(i) for i in items], multiple=bool(multiple))
    if picked is None:
        return None
    chosen = [items[i] for i in picked]
    return chosen if multiple else (chosen[0] if chosen else None)


def edit_list_dialog(title="", items=None, move=True, delete=True):
    """Let the user reorder (move) and remove (delete) items; returns the new list or None."""
    items = list(items or [])
    order = call("editList", title=str(title), items=[_label(i) for i in items], move=bool(move), delete=bool(delete))
    return None if order is None else [items[i] for i in order]


_TEXT_TYPES = {"text", "url", "email", "password", "number"}
_FIELD_TYPES = _TEXT_TYPES | {"switch", "check", "datetime", "date", "time"}


def _field(field, index):
    kind = field.get("type")
    if kind not in _FIELD_TYPES:
        raise ValueError(f"unknown form field type {kind!r}")
    key = field.get("key", field.get("title", str(index)))
    value = field.get("value")
    if kind in ("datetime", "date", "time") and value is not None and not isinstance(value, str):
        value = value.isoformat()
    return {
        "type": kind, "key": str(key), "title": str(field.get("title", "")), "value": value,
        "placeholder": str(field.get("placeholder", "")), "autocorrection": field.get("autocorrection"),
        "autocapitalization": field.get("autocapitalization"),
    }


def form_dialog(title="", fields=None, sections=None):
    """A form with fields; returns a dict of their values (by 'key') or None if cancelled.

    Each field is a dict with 'type' ('text', 'url', 'email', 'password', 'number',
    'switch', 'check', 'datetime', 'date', 'time'), 'key', 'title', 'value' and,
    for text fields, 'placeholder'. sections is a list of (title, fields[, footer]).
    """
    if sections is None:
        sections = [("", fields or [])]
    payload, kinds, n = [], {}, 0
    for section in sections:
        sec_title, sec_fields = section[0], section[1]
        footer = section[2] if len(section) > 2 else ""
        out = []
        for f in sec_fields:
            spec = _field(f, n)
            n += 1
            kinds[spec["key"]] = spec["type"]
            out.append(spec)
        payload.append({"title": str(sec_title or ""), "footer": str(footer or ""), "fields": out})
    values = call("form", title=str(title), sections=payload)
    if values is None:
        return None
    values = {key: values.get(key) for key in kinds}  # in the form's order
    for key, kind in kinds.items():
        if kind in ("datetime", "date", "time") and values.get(key):
            values[key] = parse_datetime(values[key])
    return values


def text_dialog(title="", text="", font=("<system>", 16), autocorrection=None, autocapitalization=None,
                spellchecking=None):
    """A multi-line text editor; returns the text or None if cancelled."""
    size = font[1] if isinstance(font, (tuple, list)) and len(font) > 1 else 16
    mono = isinstance(font, (tuple, list)) and font and "mono" in str(font[0]).lower()
    return call("text", title=str(title), text=str(text or ""), size=float(size), monospaced=bool(mono),
                autocorrection=autocorrection, spellchecking=spellchecking)


def _date(mode, title):
    value = call("date", title=str(title), mode=mode)
    if value is None:
        return None
    return float(value) if mode == "duration" else parse_datetime(value)


def date_dialog(title=""):
    """Pick a date; returns a datetime.datetime (at midnight) or None."""
    return _date("date", title)


def time_dialog(title=""):
    """Pick a time of day; returns a datetime.datetime (today) or None."""
    return _date("time", title)


def datetime_dialog(title=""):
    """Pick a date and time; returns a datetime.datetime or None."""
    return _date("datetime", title)


def duration_dialog(title=""):
    """Pick a duration (a countdown); returns seconds as a float, or None."""
    return _date("duration", title)


def share_text(text):
    """The share sheet for text; returns the chosen activity or None."""
    return call("share", items=[{"text": str(text)}])


def share_url(url):
    """The share sheet for a URL; returns the chosen activity or None."""
    return call("share", items=[{"url": str(url)}])


def share_image(img):
    """The share sheet for an image (PIL image, bytes or a file path)."""
    return call("share", items=[{"image": image_payload(img)}])


def pick_document(types=("public.data",)):
    """The document picker (Files, iCloud Drive, other apps); returns a path to a copy, or None.

    types are Uniform Type Identifiers, e.g. ['public.image', 'public.plain-text'].
    """
    if isinstance(types, str):
        types = [types]
    picked = call("pickDocument", types=list(types))
    if picked is None:
        return None
    return temp_file(picked["data"], picked["name"])
