import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MATCHER = load_module("menu_matcher_tests", "src/match-menus.py")
PHOTO_MAP = load_module("photo_map_tests", "src/build-photo-map.py")
CONFIG = {
    "acceptThreshold": 0.9,
    "reviewThreshold": 0.75,
    "closeAlternativeDelta": 0.03,
    "variantTokens": {
        "temperature": {"hot": "hot", "iced": "iced", "ice": "iced", "ais": "iced"},
        "size": {"small": "small", "large": "large", "s": "small", "l": "large"},
    },
    "synonyms": {"ais": "iced"},
}


def typed_item(name, price=10, currency="MYR"):
    return {"name": name, "priceText": None if price is None else f"RM {price:.2f}",
            "priceValue": price, "currency": currency}


def photo_item(name, price=10, *, status="success", prices=None, currency="MYR"):
    value = {"name": name, "status": status, "confidence": 0.95}
    if prices is None:
        value.update({"priceText": None if price is None else str(price),
                      "priceValue": price, "currency": currency,
                      "prices": [{"priceText": str(price), "priceValue": price,
                                  "currency": currency, "confidence": 0.97}] if price is not None else []})
    else:
        value["prices"] = prices
        value.update({"priceText": None, "priceValue": None, "currency": None})
    return value


def restaurant(place_id="ChIJtest", items=None, menu_status="success", photos=None):
    return {
        "placeId": place_id, "name": f"Shop {place_id}", "area": "KL",
        "menuScrape": {"status": menu_status},
        "menu": {"sections": [{"name": "Drinks", "items": items or []}]},
        "photos": photos or [{"photoId": "photo-1", "uploadDate": {"text": "Nov 2026", "year": 2026, "month": 11},
                               "fullSizeImageUrl": "https://example.test/photo-1.jpg"}],
    }


def image(file_name="menu.jpg", items=None, status="success"):
    return {"fileName": file_name, "status": status, "items": items or [], "unpairedPrices": []}


def run_one(google_items, photo_items, *, menu_status="success", images=None, photos=None):
    images = images or [image(items=photo_items)]
    mapping = {entry["fileName"]: {"placeId": "ChIJtest", "photoId": f"photo-{index + 1}", "source": "photo_map"}
               for index, entry in enumerate(images)}
    if photos is None:
        photos = [{"photoId": f"photo-{index + 1}", "uploadDate": {"text": f"Nov {2026-index}", "year": 2026-index, "month": 11},
                   "fullSizeImageUrl": f"https://example.test/photo-{index + 1}.jpg"}
                  for index in range(len(images))]
    result = MATCHER.run_matching([restaurant(items=google_items, menu_status=menu_status, photos=photos)],
                                  {"images": images}, mapping, CONFIG)
    return result["places"][0]


class MenuMatchingTests(unittest.TestCase):
    def test_exact_name_and_price_is_match(self):
        place = run_one([typed_item("Iced Latte", 12)], [photo_item("ICED LATTE", 12)])
        self.assertEqual(place["items"][0]["status"], "MATCH")
        self.assertTrue(place["items"][0]["priceMatch"])

    def test_same_name_different_price_is_price_diff(self):
        place = run_one([typed_item("Latte", 12)], [photo_item("Latte", 13)])
        self.assertEqual(place["items"][0]["status"], "PRICE_DIFF")

    def test_ocr_typo_stays_in_review_band(self):
        place = run_one([typed_item("Latte", 12)], [photo_item("Lattc", 12)])
        self.assertEqual(place["items"][0]["status"], "REVIEW")

    def test_hot_and_iced_do_not_cross_match(self):
        place = run_one(
            [typed_item("Hot Latte", 10), typed_item("Iced Latte", 12)],
            [photo_item("Iced Latte", 12), photo_item("Hot Latte", 10)],
        )
        pairs = {(row["google"]["name"], row["photo"]["name"]) for row in place["items"]}
        self.assertEqual(pairs, {("Hot Latte", "Hot Latte"), ("Iced Latte", "Iced Latte")})

    def test_multiple_unlabelled_prices_are_review_not_guessed(self):
        prices = [
            {"priceText": "10", "priceValue": 10, "currency": None, "label": None},
            {"priceText": "12", "priceValue": 12, "currency": None, "label": None},
        ]
        place = run_one([typed_item("Latte", 10)], [photo_item("Latte", prices=prices)])
        self.assertEqual(place["items"][0]["status"], "REVIEW")
        self.assertIsNone(place["items"][0]["priceMatch"])

    def test_missing_google_price_is_not_comparable(self):
        place = run_one([typed_item("Latte", None)], [photo_item("Latte", 12)])
        self.assertEqual(place["items"][0]["status"], "PRICE_NOT_COMPARABLE")

    def test_newest_conflicting_photo_price_is_used_but_reviewed(self):
        images = [image("old.jpg", [photo_item("Latte", 10)]), image("new.jpg", [photo_item("Latte", 12)])]
        photos = [
            {"photoId": "photo-1", "uploadDate": {"text": "Oct 2026", "year": 2026, "month": 10}},
            {"photoId": "photo-2", "uploadDate": {"text": "Nov 2026", "year": 2026, "month": 11}},
        ]
        place = run_one([typed_item("Latte", 12)], [], images=images, photos=photos)
        row = place["items"][0]
        self.assertEqual(row["status"], "REVIEW")
        self.assertEqual(row["photo"]["fileName"], "new.jpg")
        self.assertIn("conflicting_photo_prices", row["reasons"])

    def test_ambiguous_parser_item_never_becomes_match(self):
        place = run_one([typed_item("Latte", 12)], [photo_item("Latte", 12, status="ambiguous")])
        self.assertEqual(place["items"][0]["status"], "REVIEW")

    def test_unlinked_image_is_reported_and_not_matched(self):
        result = MATCHER.run_matching([restaurant(items=[typed_item("Latte", 12)])],
                                      {"images": [image(items=[photo_item("Latte", 12)])]}, {}, CONFIG)
        self.assertEqual(result["counts"]["unlinkedImages"], 1)
        self.assertEqual(result["places"][0]["placeStatus"], "NO_MENU_PHOTOS")
        self.assertEqual(result["places"][0]["items"][0]["status"], "ONLY_GOOGLE")

    def test_explicit_place_with_missing_photo_id_is_photos_not_linked(self):
        unlinked = image(items=[photo_item("Latte", 12)])
        unlinked["placeId"] = "ChIJtest"
        result = MATCHER.run_matching([restaurant(items=[typed_item("Latte", 12)])],
                                      {"images": [unlinked]}, {}, CONFIG)
        self.assertEqual(result["places"][0]["placeStatus"], "PHOTOS_NOT_LINKED")

    def test_none_and_failed_menu_statuses_remain_distinct(self):
        records = [restaurant("ChIJnone", [], "none"), restaurant("ChIJfailed", [], "failed")]
        result = MATCHER.run_matching(records, {"images": []}, {}, CONFIG)
        statuses = {place["placeId"]: place["placeStatus"] for place in result["places"]}
        self.assertEqual(statuses["ChIJnone"], "NO_GOOGLE_MENU")
        self.assertEqual(statuses["ChIJfailed"], "GOOGLE_MENU_FAILED")

    def test_numeric_ocr_price_compares_without_currency_assumption(self):
        place = run_one([typed_item("Latte", 12)], [photo_item("Latte", 12, currency=None)])
        row = place["items"][0]
        self.assertEqual(row["status"], "MATCH")
        self.assertFalse(row["currencyCompared"])
        self.assertIsNone(row["photo"]["currency"])

    def test_one_to_one_close_alternative_marks_pair_review(self):
        place = run_one([typed_item("Latte", 12)], [photo_item("Latte", 12), photo_item("Latte", 12)])
        statuses = sorted(row["status"] for row in place["items"])
        self.assertEqual(statuses, ["ONLY_PHOTO", "REVIEW"])

    def test_photo_map_builder_links_exact_photo_ids(self):
        rows = PHOTO_MAP.build_photo_map(
            [{"ImageFile": "menu.jpg", "PhotoId": "photo-1"}],
            [{"photoId": "photo-1", "placeId": "ChIJtest"}],
        )
        self.assertEqual(rows, [{"fileName": "menu.jpg", "placeId": "ChIJtest", "photoId": "photo-1"}])


if __name__ == "__main__":
    unittest.main()
