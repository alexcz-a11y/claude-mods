"""Orders per sales channel in each region."""


def build(backend, day):
    counts = {}
    for order in backend.scan("orders", day):
        store = backend.get("stores", order["store_id"])
        region = backend.get("regions", store["region_id"])
        channels = counts.setdefault(region["name"], {})
        channels[order["channel"]] = channels.get(order["channel"], 0) + 1
    return [
        {"region": region, "channel": channel, "orders": counts[region][channel]}
        for region in sorted(counts)
        for channel in sorted(counts[region])
    ]
