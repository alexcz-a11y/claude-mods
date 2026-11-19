"""Parcels sent and shipping cost per store."""


def build(backend, day):
    shipments = backend.scan("shipments", day)
    store_ids = sorted({shipment["store_id"] for shipment in shipments})
    rows = []
    for store_id in store_ids:
        mine = [shipment for shipment in shipments if shipment["store_id"] == store_id]
        rows.append({
            "store": backend.get("stores", store_id)["name"],
            "parcels": sum(shipment["parcels"] for shipment in mine),
            "cost_cents": sum(shipment["cost_cents"] for shipment in mine),
        })
    return sorted(rows, key=lambda row: row["store"])
