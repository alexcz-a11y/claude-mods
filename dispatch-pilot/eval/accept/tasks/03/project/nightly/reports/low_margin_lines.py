"""Order lines sold for less than 20 % over cost, with the supplier to talk to."""


def _thin(item, product):
    return item["price_cents"] * 10 < product["cost_cents"] * 12


def build(backend, day):
    rows = []
    for item in backend.scan("order_items", day):
        product = backend.get("products", item["product_id"])
        if not _thin(item, product):
            continue
        supplier = backend.get("suppliers", product["supplier_id"])
        rows.append({
            "line": item["id"],
            "product": product["name"],
            "supplier": supplier["name"],
            "price_cents": item["price_cents"],
            "cost_cents": product["cost_cents"],
        })
    return sorted(rows, key=lambda row: row["line"])
