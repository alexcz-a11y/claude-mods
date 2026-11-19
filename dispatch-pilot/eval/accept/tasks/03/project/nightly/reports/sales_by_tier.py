"""Order count and revenue per customer tier."""


def build(backend, day):
    totals = {}
    for order in backend.scan("orders", day):
        customer = backend.get("customers", order["customer_id"])
        row = totals.setdefault(customer["tier"], {"tier": customer["tier"], "orders": 0, "total_cents": 0})
        row["orders"] += 1
        row["total_cents"] += order["total_cents"]
    return sorted(totals.values(), key=lambda row: row["tier"])
