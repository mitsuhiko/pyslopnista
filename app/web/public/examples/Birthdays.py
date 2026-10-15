# Upcoming birthdays from your contacts. Tap one for a reminder, a yearly
# notification or a message.
#
# Uses contacts, reminders, notification and webbrowser (for the message).
# Tap × to close it.
import datetime as dt
import webbrowser

import contacts
import notification
import reminders
import ui


def next_birthday(born, today):
    for year in (today.year, today.year + 1):
        try:
            day = born.replace(year=year)
        except ValueError:  # 29 February
            day = dt.date(year, 3, 1)
        if day >= today:
            return day
    return today


def upcoming():
    today = dt.date.today()
    people = []
    for person in contacts.get_all_people():
        if not person.birthday:
            continue
        born = person.birthday.date()
        day = next_birthday(born, today)
        people.append({
            "name": person.full_name,
            "day": day,
            "days": (day - today).days,
            "age": None if born.year == 1604 else day.year - born.year,  # 1604: no year given
            "phone": person.phone[0][1] if person.phone else "",
        })
    return sorted(people, key=lambda p: p["days"])


def when(p):
    soon = {0: "today", 1: "tomorrow"}.get(p["days"], f"in {p['days']} days")
    turns = f", turns {p['age']}" if p["age"] else ""
    return f"{p['day'].day} {p['day']:%B}, {soon}{turns}"


def Birthdays():
    people = ui.signal(upcoming())

    async def pick(p):
        choice = await ui.choose(p["name"], ["Remind me the day before", "Notify me every year", "Send a message"])
        if choice == "Remind me the day before":
            r = reminders.Reminder()
            r.title = f"{p['name']}'s birthday is tomorrow"
            r.due_date = dt.datetime.combine(p["day"] - dt.timedelta(days=1), dt.time(9))
            alarm = reminders.Alarm()
            alarm.date = r.due_date
            r.alarms = [alarm]
            r.save()
            ui.toast("Added to Reminders")
        elif choice == "Notify me every year":
            notification.schedule(f"It's {p['name']}'s birthday!", title="Birthday", sound_name="default",
                                  trigger={"month": p["day"].month, "day": p["day"].day, "hour": 9, "repeats": True})
            ui.toast("You'll get a notification")
        elif choice == "Send a message":
            webbrowser.open(f"sms:{p['phone'].replace(' ', '')}&body=Happy%20birthday!")

    def row(p):
        return ui.Row(p["name"], subtitle=when(p), icon="gift.fill" if p["days"] < 7 else "gift", accessory="chevron",
                      on_click=lambda: pick(p))

    return ui.Screen(
        "Birthdays",
        ui.Section(
            ui.For(people, row, fallback=ui.Text("No birthdays in your contacts yet.", color="secondary")),
            footer="From your contacts. Add birthdays in the Contacts app.",
        ),
        trailing=ui.Button(icon="arrow.clockwise", kind="plain", on_click=lambda: people.set(upcoming())),
    )


ui.run(Birthdays)
