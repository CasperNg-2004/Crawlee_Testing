import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "parse-menu-ocr.py"
SPEC = importlib.util.spec_from_file_location("parse_menu_ocr", MODULE_PATH)
PARSER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PARSER
SPEC.loader.exec_module(PARSER)


def line(text, box, confidence=0.99):
    return {"text": text, "box": box, "confidence": confidence}


def image(lines):
    return {
        "fileName": "test-menu.jpg",
        "status": "success",
        "lines": lines,
        "priceCandidates": [],
    }


class MenuOcrParserTests(unittest.TestCase):
    def test_pairs_two_columns_without_crossing(self):
        result = PARSER.parse_image(
            image(
                [
                    line("COFFEE", [10, 5, 100, 25]),
                    line("LATTE", [10, 50, 100, 75]),
                    line("12.90", [210, 50, 270, 75]),
                    line("DESSERTS", [320, 5, 450, 25]),
                    line("CAKE", [320, 50, 400, 75]),
                    line("15.90", [520, 50, 580, 75]),
                ]
            ),
            [],
        )
        self.assertEqual([item["name"] for item in result["items"]], ["LATTE", "CAKE"])
        self.assertEqual(result["items"][0]["priceValue"], 12.9)
        self.assertEqual(result["items"][1]["priceValue"], 15.9)
        self.assertIsNone(result["items"][0]["currency"])

    def test_groups_multiple_prices_for_one_item(self):
        result = PARSER.parse_image(
            image(
                [
                    line("MENU", [10, 5, 1000, 25]),
                    line("SPANISH LATTE", [10, 50, 150, 75]),
                    line("RM 13.90", [220, 50, 300, 75]),
                    line("RM 15.90", [300, 50, 380, 75]),
                ]
            ),
            [],
        )
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(len(result["items"][0]["prices"]), 2)
        self.assertIsNone(result["items"][0]["priceValue"])
        self.assertEqual(
            [price["currency"] for price in result["items"][0]["prices"]],
            ["MYR", "MYR"],
        )

    def test_does_not_pair_promotional_price_sentence(self):
        result = PARSER.parse_image(
            image(
                [
                    line("NON-COFFEE", [10, 50, 160, 75]),
                    line("+ RM3 UPGRADE TO CHAMPION BEAN", [220, 50, 600, 75]),
                ]
            ),
            [],
        )
        self.assertEqual(result["items"], [])
        self.assertEqual(result["unpairedPrices"][0]["reason"], "mixed_non_price_text")

    def test_fuzzy_match_validates_but_does_not_replace_ocr_name(self):
        result = PARSER.parse_image(
            image(
                [
                    line("SPANlSH LATIE", [10, 50, 170, 75]),
                    line("RM 13.90", [220, 50, 300, 75]),
                ]
            ),
            [{"name": "Spanish Latte", "section": "Coffee"}],
            fuzzy_threshold=0.7,
        )
        self.assertEqual(result["items"][0]["name"], "SPANlSH LATIE")
        self.assertEqual(
            result["items"][0]["typedMenuMatch"]["name"], "Spanish Latte"
        )

    def test_ground_truth_counts_correct_wrong_and_missed_prices(self):
        parsed = PARSER.parse_image(
            image(
                [
                    line("MENU", [10, 5, 1000, 25]),
                    line("LATTE", [10, 50, 100, 75]),
                    line("12.90", [210, 50, 270, 75]),
                    line("MOCHA", [10, 100, 100, 125]),
                    line("16.90", [210, 100, 270, 125]),
                ]
            ),
            [],
        )
        evaluation = PARSER.evaluate(
            [parsed],
            {
                "test-menu.jpg": {
                    "fileName": "test-menu.jpg",
                    "expectedPrices": [12.9, 15.9],
                    "items": [],
                }
            },
        )
        self.assertEqual(evaluation["correctPrices"], 1)
        self.assertEqual(evaluation["wrongPrices"], 1)
        self.assertEqual(evaluation["missedPrices"], 1)

    def test_human_verified_unpaired_price_is_added_without_guessing(self):
        result = PARSER.parse_image(
            image(
                [
                    line("SPECIAL LATTE", [10, 50, 160, 75]),
                    line("+ RM3 UPGRADE OFFER", [220, 50, 500, 75]),
                ]
            ),
            [],
            {
                "test-menu.jpg::1": {
                    "key": "test-menu.jpg::1",
                    "category": "addon_price",
                    "itemName": "Extra espresso shot",
                    "priceText": "+ RM3",
                    "priceValue": 3,
                    "currency": "MYR",
                    "variantLabel": None,
                }
            },
        )
        self.assertEqual(result["items"][0]["name"], "Extra espresso shot")
        self.assertTrue(result["items"][0]["humanVerified"])
        self.assertEqual(result["counts"]["verifiedCorrections"], 1)
        self.assertEqual(result["counts"]["unpairedPriceLines"], 0)

    def test_not_a_price_label_resolves_without_creating_item(self):
        result = PARSER.parse_image(
            image([line("PRODUCT CODE 765", [10, 50, 250, 75]), line("765", [300, 50, 350, 75])]),
            [],
            {
                "test-menu.jpg::1": {
                    "key": "test-menu.jpg::1",
                    "category": "not_a_price",
                }
            },
        )
        self.assertEqual(result["items"], [])
        self.assertEqual(result["counts"]["resolvedUnpairedPriceLines"], 1)
        self.assertEqual(result["counts"]["unpairedPriceLines"], 0)


if __name__ == "__main__":
    unittest.main()
