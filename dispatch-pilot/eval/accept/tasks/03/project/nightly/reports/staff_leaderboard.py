"""Orders and revenue per member of staff, best first."""


def build(backend, day):
    board = {}
    for order in backend.scan("orders", day):
        name = backend.get("staff", order["staff_id"])["name"]
        row = board.setdefault(name, {"staff": name, "orders": 0, "total_cents": 0})
        row["orders"] += 1
        row["total_cents"] += order["total_cents"]
    return sorted(board.values(), key=lambda row: (-row["total_cents"], row["staff"]))
