"""Runs every report of the project under test against the hidden data with a counting backend.

usage: harness.py <project dir> <db.json> <results.json>
Writes {"<day>/<report>": {"calls": n, "rows": [...]}} or {"error": "..."} per report.
"""
import json
import sys
import traceback

FACT_TABLES = ("orders", "order_items", "returns", "shipments", "tickets")
DAYS = ("2031-05-12", "2031-05-13")
REPORTS = (
    "away_sales", "carrier_costs", "carrier_regions", "category_revenue", "channel_by_region",
    "customer_regions", "gold_orders", "low_margin_lines", "product_margin", "refunds_by_store",
    "returns_by_category", "returns_by_customer", "sales_by_region", "sales_by_tier", "staff_leaderboard",
    "store_shipping", "supplier_volume", "ticket_minutes", "ticket_products", "top_products",
)


class CountingBackend:
    """The platform client's three calls, each counted."""

    def __init__(self, tables):
        self._tables = tables
        self._by_id = {name: {row["id"]: row for row in rows} for name, rows in tables.items()}
        self.calls = 0

    def scan(self, table, day):
        if table not in FACT_TABLES:
            raise ValueError(f"{table} cannot be scanned; fetch its rows by id")
        self.calls += 1
        return [dict(row) for row in self._tables[table] if row["day"] == day]

    def get(self, table, key):
        self.calls += 1
        row = self._by_id[table].get(key)
        return None if row is None else dict(row)

    def get_many(self, table, keys):
        self.calls += 1
        rows = self._by_id[table]
        return {key: dict(rows[key]) for key in dict.fromkeys(keys) if key in rows}


def main():
    target, db_path, results_path = sys.argv[1:4]
    sys.path.insert(0, target)
    with open(db_path, encoding="utf-8") as handle:
        tables = json.load(handle)

    try:
        from nightly import runner
        run = runner.run_report
    except Exception:  # the registry is the fallback when the runner has been reshaped
        from nightly.reports import REPORTS as registry

        def run(backend, name, day):
            return registry[name](backend, day)

    results = {}
    for day in DAYS:
        for name in REPORTS:
            backend = CountingBackend(tables)
            try:
                rows = run(backend, name, day)
                results[f"{day}/{name}"] = {"calls": backend.calls, "rows": json.loads(json.dumps(rows))}
            except Exception:
                results[f"{day}/{name}"] = {"error": traceback.format_exc(limit=3).strip().splitlines()[-1]}
    with open(results_path, "w", encoding="utf-8") as handle:
        json.dump(results, handle)


if __name__ == "__main__":
    main()
