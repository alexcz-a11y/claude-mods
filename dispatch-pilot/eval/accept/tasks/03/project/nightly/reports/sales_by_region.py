"""Revenue per region, by the region of the store that took the order."""
from collections import Counter


def _region_of(backend, store_id):
    store = backend.get("stores", store_id)
    return backend.get("regions", store["region_id"])["name"]


def build(backend, day):
    revenue = Counter()
    for order in backend.scan("orders", day):
        revenue[_region_of(backend, order["store_id"])] += order["total_cents"]
    return [{"region": region, "total_cents": cents} for region, cents in sorted(revenue.items())]
