"""Margin per product: what the units sold brought in, minus what they cost us."""
from collections import defaultdict


def build(backend, day):
    margin = defaultdict(int)
    for item in backend.scan("order_items", day):
        product = backend.get("products", item["product_id"])
        margin[product["name"]] += item["qty"] * (item["price_cents"] - product["cost_cents"])
    return [
        {"product": name, "margin_cents": cents}
        for name, cents in sorted(margin.items(), key=lambda pair: (pair[1], pair[0]))
    ]
