"""Refund totals per store, largest first."""


def build(backend, day):
    by_store = {}
    for returned in backend.scan("returns", day):
        by_store.setdefault(returned["store_id"], []).append(returned["amount_cents"])
    rows = [
        {"store": backend.get("stores", store_id)["name"], "returns": len(amounts), "refund_cents": sum(amounts)}
        for store_id, amounts in by_store.items()
    ]
    return sorted(rows, key=lambda row: (-row["refund_cents"], row["store"]))
