"""The ten products with the most units sold."""
from collections import Counter

LIMIT = 10


def build(backend, day):
    units = Counter()
    names = {}
    for item in backend.scan("order_items", day):
        product_id = item["product_id"]
        if product_id not in names:
            names[product_id] = backend.get("products", product_id)["name"]
        units[product_id] += item["qty"]
    ranked = sorted(units.items(), key=lambda pair: (-pair[1], names[pair[0]]))
    return [{"product": names[product_id], "units": count} for product_id, count in ranked[:LIMIT]]
