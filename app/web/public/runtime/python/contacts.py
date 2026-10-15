"""The address book: read, add and change contacts and groups.

    import contacts
    for p in contacts.get_all_people():
        print(p.full_name, p.phone)

    p = contacts.Person()
    p.first_name, p.last_name = "Ada", "Lovelace"
    p.email = [(contacts.WORK, "ada@example.com")]
    contacts.add_person(p)
    contacts.save()

The first use asks for permission. Multi-value fields (phone, email, url,
address, ...) are lists of (label, value) tuples; assign a changed list back
to the attribute, then call save(). Ids are strings. The notes field is not
available to apps without a special entitlement and is always None.
"""

import base64
import datetime as _dt

from _device import call, parse_datetime

__all__ = [
    "Person", "Group", "get_all_people", "get_person", "find", "add_person", "remove_person", "get_all_groups",
    "get_group", "add_group", "remove_group", "save", "revert", "localized_label", "is_authorized",
]

HOME, WORK, OTHER = "_$!<Home>!$_", "_$!<Work>!$_", "_$!<Other>!$_"
IPHONE, MOBILE, MAIN_PHONE = "iPhone", "_$!<Mobile>!$_", "_$!<Main>!$_"
HOME_FAX, WORK_FAX, OTHER_FAX, PAGER = "_$!<HomeFAX>!$_", "_$!<WorkFAX>!$_", "_$!<OtherFAX>!$_", "_$!<Pager>!$_"
FATHER, MOTHER, PARENT = "_$!<Father>!$_", "_$!<Mother>!$_", "_$!<Parent>!$_"
BROTHER, SISTER, CHILD = "_$!<Brother>!$_", "_$!<Sister>!$_", "_$!<Child>!$_"
FRIEND, SPOUSE, PARTNER = "_$!<Friend>!$_", "_$!<Spouse>!$_", "_$!<Partner>!$_"
ASSISTANT, MANAGER = "_$!<Assistant>!$_", "_$!<Manager>!$_"
HOMEPAGE = "_$!<HomePage>!$_"
STREET, CITY, STATE, ZIP, COUNTRY, COUNTRY_CODE = "Street", "City", "State", "ZIP", "Country", "CountryCode"

_STRINGS = (
    "first_name", "middle_name", "last_name", "prefix", "suffix", "nickname", "first_name_phonetic",
    "middle_name_phonetic", "last_name_phonetic", "organization", "job_title", "department",
)
_MULTI = ("phone", "email", "url", "related_names", "address", "social_profile", "instant_message")

_pending = {"add": [], "update": {}, "remove": [], "add_groups": [], "update_groups": {}, "remove_groups": []}


class Person:
    """A contact. Create one and add_person() it, or change one from get_all_people(); then save()."""

    def __init__(self, _info=None):
        object.__setattr__(self, "_info", dict(_info or {"id": None, "kind": 0}))

    def __repr__(self):
        return f"<contacts.Person {self.full_name!r}>"

    def __getattr__(self, name):
        info = object.__getattribute__(self, "_info")
        if name in _STRINGS:
            return info.get(name) or None
        if name in _MULTI:
            return [tuple(item) for item in info.get(name) or []]
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name in ("note",):
            return  # not available (entitlement)
        if name == "birthday":
            value = None if value is None else value.isoformat()
        elif name == "image_data":
            value = None if value is None else base64.b64encode(value).decode("ascii")
        elif name in _MULTI:
            value = [[label, dict(v) if isinstance(v, dict) else str(v)] for label, v in value]
        elif name in _STRINGS:
            value = None if value is None else str(value)
        elif name == "kind":
            value = int(value)
        else:
            raise AttributeError(f"Person has no writable attribute {name!r}")
        self._info[name] = value
        if self._info.get("id"):
            _pending["update"].setdefault(self._info["id"], {})[name] = value

    id = property(lambda self: self._info.get("id") or -1)
    kind = property(lambda self: self._info.get("kind", 0), lambda self, v: self.__setattr__("kind", v))
    note = property(lambda self: None)
    creation_date = property(lambda self: None)
    modification_date = property(lambda self: None)

    @property
    def full_name(self):
        if self._info.get("full_name"):
            return self._info["full_name"]
        parts = [self._info.get(k) for k in ("prefix", "first_name", "middle_name", "last_name", "suffix")]
        return " ".join(p for p in parts if p) or self._info.get("organization") or ""

    @property
    def birthday(self):
        value = self._info.get("birthday")
        return None if not value else parse_datetime(value)

    @property
    def image_data(self):
        value = self._info.get("image_data")
        return None if not value else base64.b64decode(value)

    @property
    def vcard(self):
        if not self._info.get("id"):
            return ""
        return call("contacts.vcard", id=self._info["id"])


class Group:
    """A group of contacts."""

    def __init__(self, _info=None):
        self._info = dict(_info or {"id": None, "name": ""})

    def __repr__(self):
        return f"<contacts.Group {self.name!r}>"

    id = property(lambda self: self._info.get("id") or -1)

    @property
    def name(self):
        return self._info.get("name", "")

    @name.setter
    def name(self, value):
        self._info["name"] = str(value)
        if self._info.get("id"):
            _pending["update_groups"][self._info["id"]] = str(value)


def is_authorized():
    """Whether the app may read the contacts (asks the first time)."""
    return bool(call("contacts.authorized"))


def get_all_people():
    """Every person in the address book."""
    return [Person(p) for p in call("contacts.people")]


def find(name):
    """People whose name matches."""
    return [Person(p) for p in call("contacts.people", query=str(name))]


def get_person(person_id):
    """The person with this id, or None."""
    info = call("contacts.person", id=str(person_id))
    return None if info is None else Person(info)


def add_person(person):
    """Add a new Person (saved with save())."""
    _pending["add"].append(person)


def remove_person(person):
    """Remove a person (with save())."""
    if person._info.get("id"):
        _pending["remove"].append(person._info["id"])
    elif person in _pending["add"]:
        _pending["add"].remove(person)


def get_all_groups():
    return [Group(g) for g in call("contacts.groups")]


def get_group(group_id):
    for g in get_all_groups():
        if g._info["id"] == group_id:
            return g
    return None


def add_group(group=None):
    """Add a Group (saved with save()); returns it."""
    group = group or Group()
    _pending["add_groups"].append(group)
    return group


def remove_group(group):
    if group._info.get("id"):
        _pending["remove_groups"].append(group._info["id"])


def save():
    """Write all pending changes to the address book."""
    adds = list(_pending["add"])
    groups = list(_pending["add_groups"])
    ids = call(
        "contacts.save",
        add=[{k: v for k, v in p._info.items() if k != "id"} for p in adds],
        update=[{"id": i, "changes": c} for i, c in _pending["update"].items()],
        remove=_pending["remove"],
        add_groups=[g.name for g in groups],
        update_groups=[{"id": i, "name": n} for i, n in _pending["update_groups"].items()],
        remove_groups=_pending["remove_groups"],
    )
    for person, new_id in zip(adds, ids.get("people", [])):
        person._info["id"] = new_id
    for group, new_id in zip(groups, ids.get("groups", [])):
        group._info["id"] = new_id
    revert()


def revert():
    """Forget the pending changes."""
    for key, value in _pending.items():
        value.clear()


def localized_label(label):
    """A label constant as people read it ('_$!<Home>!$_' -> 'home')."""
    return call("contacts.label", label=str(label))
