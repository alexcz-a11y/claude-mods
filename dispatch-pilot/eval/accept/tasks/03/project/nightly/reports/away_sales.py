"""Orders taken by staff at a store other than their own."""


def build(backend, day):
    rows = []
    for order in backend.scan("orders", day):
        seller = backend.get("staff", order["staff_id"])
        if seller["store_id"] == order["store_id"]:
            continue
        rows.append({
            "order": order["id"],
            "staff": seller["name"],
            "home_store": backend.get("stores", seller["store_id"])["name"],
            "sold_at": backend.get("stores", order["store_id"])["name"],
        })
    return sorted(rows, key=lambda row: row["order"])
