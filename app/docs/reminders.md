# reminders — Reminders and lists

Read, add, check off and delete reminders in the Reminders app, and manage
its lists. The first use asks for permission.

```python
import reminders
import datetime

for r in reminders.get_reminders(completed=False):
    print("[ ]", r.title)

r = reminders.Reminder()
r.title = "Water the plants"
r.due_date = datetime.datetime.now() + datetime.timedelta(hours=2)
alarm = reminders.Alarm()
alarm.date = r.due_date
r.alarms = [alarm]
r.save()
```

Lists are `Calendar` objects. A due date alone doesn't notify; add an
`Alarm`.

## Functions

### reminders.get_reminders(calendar=None, completed=None)

The reminders in a list, or in all lists. `completed=True` gives only
checked-off ones, `False` only open ones.

### reminders.get_all_calendars()

All lists.

### reminders.get_default_calendar()

The list new reminders go to.

### reminders.get_calendar(calendar_id)

The list with this identifier, or None.

### reminders.delete_reminder(reminder)

Delete a reminder; True if it was deleted.

### reminders.delete_calendar(calendar)

Delete a list and its reminders; True if it was deleted.

## Reminders

### class reminders.Reminder(calendar=None)

A reminder, in `calendar` or the default list. Set its fields, then
`save()`.

#### reminders.Reminder.save()

Save the reminder.

#### reminders.Reminder.title

Its title.

#### reminders.Reminder.notes

Extra notes.

#### reminders.Reminder.due_date

When it is due (a `datetime`), or None.

#### reminders.Reminder.completed

Whether it is checked off.

#### reminders.Reminder.completion_date

When it was checked off, or None.

#### reminders.Reminder.priority

0 for none, 1 (highest) to 9 (lowest).

#### reminders.Reminder.url

A link shown with it.

#### reminders.Reminder.alarms

Its `Alarm` objects. Assign a new list to change them.

#### reminders.Reminder.identifier

Its id (None until saved).

#### reminders.Reminder.calendar

The list it is in.

## Lists

### class reminders.Calendar()

A list of reminders. Set `title` and `save()` to create one.

#### reminders.Calendar.title

The list's name.

#### reminders.Calendar.identifier

Its id (None until saved).

#### reminders.Calendar.save()

Save the list's title, creating the list if it is new.

## Alarms

### class reminders.Alarm()

When or where a reminder notifies.

#### reminders.Alarm.date

The time it goes off (a `datetime`).

#### reminders.Alarm.location

A place: `(title, latitude, longitude)` or `(title, latitude, longitude, radius)`
with the radius in meters (100 by default).

#### reminders.Alarm.proximity

For a place: `'enter'` (arriving), `'leave'` (leaving) or `'none'`.
