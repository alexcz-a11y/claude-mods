"""Orders placed by gold-tier customers, largest first."""


def build(backend, day):
    rows = []
    for order in backend.scan("orders", day):
        customer = backend.get("customers", order["customer_id"])
        if customer["tier"] != "gold":
            continue
        store = backend.get("stores", order["store_id"])
        rows.append({
            "order": order["id"],
            "customer": customer["name"],
            "store": store["name"],
            "total_cents": order["total_cents"],
        })
    return sorted(rows, key=lambda row: (-row["total_cents"], row["order"]))
