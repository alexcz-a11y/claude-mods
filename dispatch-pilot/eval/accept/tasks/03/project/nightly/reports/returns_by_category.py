"""Returned goods per product category: how many, and how much was refunded."""


def build(backend, day):
    summary = {}
    for returned in backend.scan("returns", day):
        product = backend.get("products", returned["product_id"])
        category = backend.get("categories", product["category_id"])
        row = summary.setdefault(category["id"], {"category": category["name"], "returns": 0, "refund_cents": 0})
        row["returns"] += 1
        row["refund_cents"] += returned["amount_cents"]
    return [summary[key] for key in sorted(summary)]
