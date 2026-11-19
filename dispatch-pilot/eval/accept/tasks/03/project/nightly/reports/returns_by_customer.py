"""Customers who returned something, with their refund total."""


def build(backend, day):
    returns = backend.scan("returns", day)
    customers = backend.get_many("customers", [returned["customer_id"] for returned in returns])
    refunds = {}
    for returned in returns:
        name = customers[returned["customer_id"]]["name"]
        refunds[name] = refunds.get(name, 0) + returned["amount_cents"]
    return [{"customer": name, "refund_cents": refunds[name]} for name in sorted(refunds)]
