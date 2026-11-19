"""Parcels per carrier and region of the sending store."""


def build(backend, day):
    parcels = {}
    for shipment in backend.scan("shipments", day):
        carrier = backend.get("carriers", shipment["carrier_id"])["name"]
        store = backend.get("stores", shipment["store_id"])
        region = backend.get("regions", store["region_id"])["name"]
        parcels[(carrier, region)] = parcels.get((carrier, region), 0) + shipment["parcels"]
    return [
        {"carrier": carrier, "region": region, "parcels": count}
        for (carrier, region), count in sorted(parcels.items())
    ]
