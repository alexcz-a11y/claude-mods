"""Units sold per supplier, so purchasing can see whose stock moved."""
from collections import defaultdict


def build(backend, day):
    units_by_product = defaultdict(int)
    for item in backend.scan("order_items", day):
        units_by_product[item["product_id"]] += item["qty"]

    rows = {}
    for product_id, units in units_by_product.items():
        product = backend.get("products", product_id)
        supplier = backend.get("suppliers", product["supplier_id"])
        row = rows.setdefault(
            supplier["id"], {"supplier": supplier["name"], "country": supplier["country"], "units": 0}
        )
        row["units"] += units
    return sorted(rows.values(), key=lambda row: (-row["units"], row["supplier"]))
