"""Revenue per product category."""


def _category(backend, product_id):
    product = backend.get("products", product_id)
    return backend.get("categories", product["category_id"])["name"]


def build(backend, day):
    lines = [
        (_category(backend, item["product_id"]), item["qty"] * item["price_cents"])
        for item in backend.scan("order_items", day)
    ]
    revenue = {}
    for category, cents in lines:
        revenue[category] = revenue.get(category, 0) + cents
    return [{"category": name, "revenue_cents": revenue[name]} for name in sorted(revenue)]
