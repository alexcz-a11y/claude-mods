import unittest

from standings.results import Match, ResultsError, parse

TEXT = """
# a comment
[Division One]
Alder Green 2-0 Brook End

Castle Mill   1-1   Alder Green
[Division Two]
Dene Park 0-3 Elm Cross
"""


class ParseTest(unittest.TestCase):
    def test_divisions_come_in_file_order(self):
        self.assertEqual([division.name for division in parse(TEXT)], ["Division One", "Division Two"])

    def test_a_match_line(self):
        first, second = parse(TEXT)
        self.assertEqual(first.matches[0], Match("Alder Green", "Brook End", 2, 0))
        self.assertEqual(first.matches[1], Match("Castle Mill", "Alder Green", 1, 1))
        self.assertEqual(second.matches, [Match("Dene Park", "Elm Cross", 0, 3)])

    def test_a_line_that_is_no_match_names_its_line_number(self):
        with self.assertRaisesRegex(ResultsError, "line 3"):
            parse("[Division One]\nAlder Green 2-0 Brook End\nAlder Green beat Brook End\n")

    def test_a_result_needs_a_division(self):
        with self.assertRaisesRegex(ResultsError, "line 1"):
            parse("Alder Green 2-0 Brook End\n")

    def test_a_team_cannot_play_itself(self):
        with self.assertRaises(ResultsError):
            parse("[Division One]\nAlder Green 2-0 Alder  Green\n")


if __name__ == "__main__":
    unittest.main()
