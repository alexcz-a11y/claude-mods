"""Support minutes per member of staff."""
import functools


def build(backend, day):
    @functools.lru_cache(maxsize=None)
    def staff_name(staff_id):
        return backend.get("staff", staff_id)["name"]

    minutes = {}
    for ticket in backend.scan("tickets", day):
        name = staff_name(ticket["staff_id"])
        minutes[name] = minutes.get(name, 0) + ticket["minutes"]
    return [{"staff": name, "minutes": minutes[name]} for name in sorted(minutes)]
