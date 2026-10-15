# contacts — The address book

Read, add, change and remove contacts and groups. The first use asks for
permission.

```python
import contacts

for p in contacts.get_all_people():
    if p.birthday:
        print(p.full_name, p.birthday.strftime("%d %B"))

p = contacts.Person()
p.first_name, p.last_name = "Ada", "Lovelace"
p.email = [(contacts.WORK, "ada@example.com")]
contacts.add_person(p)
contacts.save()
```

Changes are collected and written by `save()`. Fields with several values
(`phone`, `email`, `url`, `address`, ...) are lists of `(label, value)`
tuples: change a copy and assign it back to the attribute. Ids are strings.
The notes field isn't available to apps and is always None.

## Functions

### contacts.get_all_people()

Every person in the address book, as `Person` objects.

### contacts.find(name)

People whose name matches.

### contacts.get_person(person_id)

The person with this id, or None.

### contacts.add_person(person)

Add a new `Person` (written by `save()`).

### contacts.remove_person(person)

Remove a person (written by `save()`).

### contacts.get_all_groups()

All groups.

### contacts.get_group(group_id)

The group with this id, or None.

### contacts.add_group(group=None)

Add a new `Group` (written by `save()`); returns it.

### contacts.remove_group(group)

Remove a group (written by `save()`).

### contacts.save()

Write all pending changes to the address book.

### contacts.revert()

Forget the pending changes.

### contacts.localized_label(label)

A label as people read it: `contacts.HOME` becomes `'home'`.

### contacts.is_authorized()

Whether the app may use the address book (asks the first time).

## People

### class contacts.Person()

A contact. Make one, set its fields and `add_person()` it, or change one
from `get_all_people()`; then `save()`.

#### contacts.Person.first_name

The first name. Also: `middle_name`, `last_name`, `prefix`, `suffix`,
`nickname`, and the phonetic `first_name_phonetic`, `middle_name_phonetic`,
`last_name_phonetic`.

#### contacts.Person.full_name

The name as the Contacts app shows it (read-only).

#### contacts.Person.organization

The company. Also: `job_title`, `department`.

#### contacts.Person.kind

0 for a person, 1 for an organization.

#### contacts.Person.birthday

A `datetime`, or None.

#### contacts.Person.phone

Phone numbers: `[(contacts.MOBILE, '+1 555 0100'), ...]`.

#### contacts.Person.email

Email addresses, as `(label, address)` tuples.

#### contacts.Person.url

Web addresses, as `(label, url)` tuples.

#### contacts.Person.address

Postal addresses: `(label, dict)` tuples with the keys `contacts.STREET`,
`CITY`, `STATE`, `ZIP`, `COUNTRY` and `COUNTRY_CODE`.

#### contacts.Person.related_names

Related people, as `(label, name)` tuples (labels like `contacts.MOTHER`).

#### contacts.Person.social_profile

Social profiles: `(label, dict)` with `service`, `username` and `url`.

#### contacts.Person.instant_message

Messaging accounts: `(label, dict)` with `service` and `username`.

#### contacts.Person.image_data

The contact's photo as image bytes, or None.

#### contacts.Person.vcard

The contact as a vCard string (read-only).

#### contacts.Person.id

The contact's id (-1 until saved).

## Groups

### class contacts.Group()

A group of contacts.

#### contacts.Group.name

The group's name.

#### contacts.Group.id

The group's id (-1 until saved).

## Labels

### contacts.HOME

Labels for any field: `HOME`, `WORK`, `OTHER`.

### contacts.MOBILE

Labels for phone numbers: `MOBILE`, `IPHONE`, `MAIN_PHONE`, `HOME_FAX`,
`WORK_FAX`, `OTHER_FAX`, `PAGER`.

### contacts.MOTHER

Labels for related names: `FATHER`, `MOTHER`, `PARENT`, `BROTHER`,
`SISTER`, `CHILD`, `FRIEND`, `SPOUSE`, `PARTNER`, `ASSISTANT`, `MANAGER`.

### contacts.HOMEPAGE

The label for a homepage URL.

### contacts.STREET

Keys of address dicts: `STREET`, `CITY`, `STATE`, `ZIP`, `COUNTRY`,
`COUNTRY_CODE`.
