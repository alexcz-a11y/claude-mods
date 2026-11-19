"""Shipping cost and parcels per carrier."""


def build(backend, day):
    shipments = backend.scan("shipments", day)
    carriers = backend.get_many("carriers", {shipment["carrier_id"] for shipment in shipments})
    rows = {}
    for shipment in shipments:
        name = carriers[shipment["carrier_id"]]["name"]
        row = rows.setdefault(name, {"carrier": name, "parcels": 0, "cost_cents": 0})
        row["parcels"] += shipment["parcels"]
        row["cost_cents"] += shipment["cost_cents"]
    return sorted(rows.values(), key=lambda row: row["carrier"])
