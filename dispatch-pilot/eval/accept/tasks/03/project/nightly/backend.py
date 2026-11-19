"""Client for the platform team's data service.

Kept in step with the platform repository: do not edit it in this project.
Every scan(), get() and get_many() is one call to the service.
"""
import json

FACT_TABLES = ("orders", "order_items", "returns", "shipments", "tickets")


class Backend:
    def __init__(self, tables):
        self._tables = tables
        self._by_id = {name: {row["id"]: row for row in rows} for name, rows in tables.items()}
        self.calls = 0

    @classmethod
    def from_file(cls, path):
        with open(path, encoding="utf-8") as handle:
            return cls(json.load(handle))

    def scan(self, table, day):
        """Every row of a fact table for one day, in id order."""
        if table not in FACT_TABLES:
            raise ValueError(f"{table} cannot be scanned; fetch its rows by id")
        self.calls += 1
        return [dict(row) for row in self._tables[table] if row["day"] == day]

    def get(self, table, key):
        """One row by id, or None."""
        self.calls += 1
        row = self._by_id[table].get(key)
        return None if row is None else dict(row)

    def get_many(self, table, keys):
        """Rows by id as {id: row}. Ids that do not exist are left out."""
        self.calls += 1
        rows = self._by_id[table]
        return {key: dict(rows[key]) for key in dict.fromkeys(keys) if key in rows}
