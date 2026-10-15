"""Reminders: read, add, check off and delete reminders and lists.

    import reminders, datetime
    for r in reminders.get_reminders(completed=False):
        print("[ ]", r.title)

    r = reminders.Reminder()
    r.title = "Water the plants"
    r.due_date = datetime.datetime.now() + datetime.timedelta(hours=2)
    a = reminders.Alarm()
    a.date = r.due_date
    r.alarms = [a]
    r.save()

The first use asks for permission. Lists are Calendar objects.
"""

import datetime as _dt

from _device import call, parse_datetime

__all__ = [
    "Reminder", "Calendar", "Alarm", "get_reminders", "get_all_calendars", "get_default_calendar", "get_calendar",
    "delete_reminder", "delete_calendar",
]


class Calendar:
    """A list of reminders."""

    def __init__(self, _info=None):
        self._info = dict(_info or {"identifier": None, "title": ""})

    def __repr__(self):
        return f"<reminders.Calendar {self.title!r}>"

    identifier = property(lambda self: self._info.get("identifier"))

    @property
    def title(self):
        return self._info.get("title", "")

    @title.setter
    def title(self, value):
        self._info["title"] = str(value)

    def save(self):
        """Save the list's title (a new Calendar is created)."""
        self._info = call("reminders.saveCalendar", identifier=self.identifier, title=self.title)


class Alarm:
    """When (date) or where (location, proximity) a reminder notifies."""

    def __init__(self, _info=None):
        self._info = dict(_info or {})

    def __repr__(self):
        return f"<reminders.Alarm date={self.date} location={self.location}>"

    @property
    def date(self):
        return parse_datetime(self._info.get("date"))

    @date.setter
    def date(self, value):
        self._info["date"] = None if value is None else value.isoformat()

    @property
    def location(self):
        loc = self._info.get("location")
        return None if loc is None else tuple(loc)

    @location.setter
    def location(self, value):
        """(title, latitude, longitude[, radius in meters])."""
        if value is None:
            self._info["location"] = None
        else:
            title, lat, lng, *rest = value
            self._info["location"] = [str(title), float(lat), float(lng), float(rest[0]) if rest else 100.0]

    @property
    def proximity(self):
        return self._info.get("proximity", "none")

    @proximity.setter
    def proximity(self, value):
        if value not in ("enter", "leave", "none"):
            raise ValueError("proximity is 'enter', 'leave' or 'none'")
        self._info["proximity"] = value


class Reminder:
    """A reminder; set its attributes and save()."""

    def __init__(self, calendar=None, _info=None):
        self._info = dict(_info or {"identifier": None})
        if calendar is not None:
            self._info["calendar"] = calendar.identifier

    def __repr__(self):
        return f"<reminders.Reminder {self.title!r}{' (done)' if self.completed else ''}>"

    def _get(name, default=None):
        return property(lambda self: self._info.get(name, default),
                        lambda self, v: self._info.__setitem__(name, v))

    title = _get("title", "")
    notes = _get("notes")
    url = _get("url")
    priority = _get("priority", 0)
    completed = _get("completed", False)
    del _get

    identifier = property(lambda self: self._info.get("identifier"))
    completion_date = property(lambda self: parse_datetime(self._info.get("completion_date")))

    @property
    def due_date(self):
        return parse_datetime(self._info.get("due_date"))

    @due_date.setter
    def due_date(self, value):
        self._info["due_date"] = None if value is None else value.isoformat()

    @property
    def calendar(self):
        cal = self._info.get("calendar")
        return None if cal is None else get_calendar(cal)

    @property
    def alarms(self):
        return [Alarm(a) for a in self._info.get("alarms") or []]

    @alarms.setter
    def alarms(self, value):
        self._info["alarms"] = [dict(a._info) for a in value]

    def save(self):
        """Save the reminder (new ones go to their list, or the default list)."""
        self._info = call("reminders.save", reminder=self._info)


def get_reminders(calendar=None, completed=None):
    """Reminders in a list (or all lists); completed=True/False filters checked-off ones."""
    return [Reminder(_info=r) for r in call("reminders.reminders",
                                             calendar=None if calendar is None else calendar.identifier,
                                             completed=completed)]


def get_all_calendars():
    """All reminder lists."""
    return [Calendar(c) for c in call("reminders.calendars")]


def get_default_calendar():
    """The list new reminders go to."""
    info = call("reminders.defaultCalendar")
    return None if info is None else Calendar(info)


def get_calendar(calendar_id):
    """The list with this identifier, or None."""
    for c in get_all_calendars():
        if c.identifier == calendar_id:
            return c
    return None


def delete_reminder(reminder):
    """Delete a reminder; True if it was deleted."""
    return bool(call("reminders.delete", identifier=reminder.identifier)) if reminder.identifier else False


def delete_calendar(calendar):
    """Delete a list and its reminders; True if it was deleted."""
    return bool(call("reminders.deleteCalendar", identifier=calendar.identifier)) if calendar.identifier else False
