"""Which products the support tickets were about, most tickets first."""
import itertools


def build(backend, day):
    tickets = sorted(backend.scan("tickets", day), key=lambda ticket: ticket["product_id"])
    rows = []
    for product_id, group in itertools.groupby(tickets, key=lambda ticket: ticket["product_id"]):
        group = list(group)
        rows.append({
            "product": backend.get("products", product_id)["name"],
            "tickets": len(group),
            "minutes": sum(ticket["minutes"] for ticket in group),
        })
    return sorted(rows, key=lambda row: (-row["tickets"], row["product"]))
