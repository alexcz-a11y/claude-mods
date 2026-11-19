import unittest

from nightly.backend import Backend
from nightly.reports import REPORTS
from nightly.runner import run_report

DAY = "2031-03-04"


class Smoke(unittest.TestCase):
    def setUp(self):
        self.backend = Backend.from_file("fixtures/db.json")

    def test_every_report_returns_rows(self):
        for name in sorted(REPORTS):
            with self.subTest(report=name):
                rows = run_report(self.backend, name, DAY)
                self.assertIsInstance(rows, list)
                self.assertTrue(rows, f"{name} returned nothing")
                self.assertTrue(all(isinstance(row, dict) for row in rows))

    def test_tiers_add_up_to_the_day(self):
        orders = self.backend.scan("orders", DAY)
        rows = run_report(self.backend, "sales_by_tier", DAY)
        self.assertEqual(sum(row["total_cents"] for row in rows), sum(o["total_cents"] for o in orders))
        self.assertEqual(sum(row["orders"] for row in rows), len(orders))

    def test_top_products_is_capped_and_ranked(self):
        rows = run_report(self.backend, "top_products", DAY)
        self.assertLessEqual(len(rows), 10)
        units = [row["units"] for row in rows]
        self.assertEqual(units, sorted(units, reverse=True))

    def test_a_day_without_data_gives_empty_reports(self):
        for name in sorted(REPORTS):
            with self.subTest(report=name):
                self.assertEqual(run_report(self.backend, name, "2030-01-01"), [])


if __name__ == "__main__":
    unittest.main()
