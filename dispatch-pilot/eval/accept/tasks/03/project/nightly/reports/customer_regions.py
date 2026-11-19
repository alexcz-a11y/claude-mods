"""Where the day's customers are: orders and distinct customers per customer region."""


def build(backend, day):
    seen = {}
    orders = {}
    for order in backend.scan("orders", day):
        customer = backend.get("customers", order["customer_id"])
        region = backend.get("regions", customer["region_id"])["name"]
        seen.setdefault(region, set()).add(customer["id"])
        orders[region] = orders.get(region, 0) + 1
    return [
        {"region": region, "orders": orders[region], "customers": len(seen[region])}
        for region in sorted(orders)
    ]
