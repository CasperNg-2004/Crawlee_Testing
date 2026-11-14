#!/usr/bin/env python3
"""Compare Google typed-menu offers with menu offers parsed from photo OCR."""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

SRC_DIRECTORY = Path(__file__).resolve().parent
if str(SRC_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SRC_DIRECTORY))
from output_paths import stage_output_directory, typed_output


ROOT = Path(__file__).resolve().parents[1]
PARSER_PATH = ROOT / "src" / "parse-menu-ocr.py"
SPEC = importlib.util.spec_from_file_location("menu_ocr_parser_for_matching", PARSER_PATH)
PARSER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PARSER
SPEC.loader.exec_module(PARSER)

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7,
    "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restaurants", required=True)
    parser.add_argument("--structured", required=True)
    parser.add_argument("--photo-map", default=None)
    parser.add_argument("--config", default=str(ROOT / "config" / "menu-matching.json"))
    parser.add_argument("--ground-truth", default=None)
    parser.add_argument("--output-dir", default=None)
    return parser.parse_args()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def records_from_json(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        for key in ("restaurants", "places", "records", "items"):
            if isinstance(value.get(key), list):
                return [row for row in value[key] if isinstance(row, dict)]
        return [value]
    return []


def clean_text(value: Any) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text or None


def number_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def extract_place_id(record: dict[str, Any]) -> tuple[str | None, str | None]:
    explicit = clean_text(record.get("placeId"))
    if explicit:
        return explicit, "placeId"
    url = clean_text(record.get("googleMapsUrl"))
    if not url:
        return None, None
    query_id = parse_qs(urlparse(url).query).get("query_place_id", [None])[0]
    if query_id and str(query_id).startswith("ChIJ"):
        return str(query_id), "googleMapsUrl.query_place_id"
    match = re.search(r"(?:!19s|%2119s)(ChIJ[^!&/?%]+)", url)
    if match:
        return unquote(match.group(1)), "googleMapsUrl.19s"
    return None, None


def load_photo_map(path: Path | None) -> dict[str, dict[str, str]]:
    if not path:
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    output: dict[str, dict[str, str]] = {}
    for row in rows:
        file_name = clean_text(row.get("fileName"))
        place_id = clean_text(row.get("placeId"))
        photo_id = clean_text(row.get("photoId"))
        if not file_name or not place_id or not photo_id:
            continue
        current = {"placeId": place_id, "photoId": photo_id, "source": "photo_map"}
        if file_name in output and output[file_name] != current:
            raise ValueError(f"Conflicting photo-map rows for {file_name}")
        output[file_name] = current
    return output


def filename_link(file_name: str) -> dict[str, str] | None:
    stem = Path(file_name).stem
    if "__" not in stem:
        return None
    place_id, photo_id = stem.split("__", 1)
    if not place_id.startswith("ChIJ") or not photo_id:
        return None
    return {"placeId": place_id, "photoId": photo_id, "source": "filename"}


def resolve_image_link(image: dict[str, Any], photo_map: dict[str, dict[str, str]]) -> dict[str, str] | None:
    file_name = clean_text(image.get("fileName")) or ""
    place_id = clean_text(image.get("placeId"))
    photo_id = clean_text(image.get("photoId"))
    if place_id and photo_id:
        return {"placeId": place_id, "photoId": photo_id, "source": "structured_image"}
    if file_name in photo_map:
        return photo_map[file_name]
    return filename_link(file_name)


def normalize_offer_name(value: Any, config: dict[str, Any]) -> dict[str, Any]:
    normalized = PARSER.normalize_match_text(value)
    synonyms = {PARSER.normalize_match_text(k): PARSER.normalize_match_text(v)
                for k, v in (config.get("synonyms") or {}).items()}
    variant_lookup: dict[str, tuple[str, str]] = {}
    for category, mappings in (config.get("variantTokens") or {}).items():
        for token, canonical in (mappings or {}).items():
            variant_lookup[PARSER.normalize_match_text(token)] = (str(category), str(canonical))
    variants: dict[str, list[str]] = defaultdict(list)
    base_tokens: list[str] = []
    for raw_token in normalized.split():
        token = synonyms.get(raw_token, raw_token)
        variant = variant_lookup.get(token)
        if variant:
            category, canonical = variant
            if canonical not in variants[category]:
                variants[category].append(canonical)
        else:
            base_tokens.append(token)
    base = " ".join(base_tokens).strip() or " ".join(normalized.split()).strip()
    return {"normalized": normalized, "base": base, "variants": dict(variants)}


def merge_variants(*values: dict[str, list[str]]) -> dict[str, list[str]]:
    merged: dict[str, list[str]] = defaultdict(list)
    for value in values:
        for category, tokens in value.items():
            for token in tokens:
                if token not in merged[category]:
                    merged[category].append(token)
    return dict(merged)


def variants_compatible(left: dict[str, list[str]], right: dict[str, list[str]]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    for category in sorted(set(left) | set(right)):
        left_values = set(left.get(category) or [])
        right_values = set(right.get(category) or [])
        if left_values and right_values and left_values.isdisjoint(right_values):
            return False, [f"variant_mismatch:{category}"]
        if bool(left_values) != bool(right_values):
            reasons.append(f"variant_unlabelled:{category}")
    return True, reasons


def photo_date_value(value: Any) -> tuple[int, int] | None:
    if isinstance(value, dict):
        year = int(value.get("year") or 0)
        month = int(value.get("month") or 0)
        day = int(value.get("day") or 0)
        if year:
            precision = 3 if day else 2 if month else 1
            return (year * 10000 + (month or 1) * 100 + (day or 1), precision)
        value = value.get("text")
    text = clean_text(value)
    if not text:
        return None
    iso = re.fullmatch(r"((?:19|20)\d{2})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", text)
    if iso:
        year, month, day = int(iso.group(1)), int(iso.group(2) or 1), int(iso.group(3) or 1)
        return (year * 10000 + month * 100 + day, 3 if iso.group(3) else 2 if iso.group(2) else 1)
    match = re.fullmatch(r"([A-Za-z]+)\.?\s+(?:(\d{1,2}),?\s+)?((?:19|20)\d{2})", text)
    if match and match.group(1).lower() in MONTHS:
        month, day, year = MONTHS[match.group(1).lower()], int(match.group(2) or 1), int(match.group(3))
        return (year * 10000 + month * 100 + day, 3 if match.group(2) else 2)
    return None


def upload_date_text(value: Any) -> str | None:
    if isinstance(value, dict):
        return clean_text(value.get("text"))
    return clean_text(value)


def flatten_google_offers(record: dict[str, Any], config: dict[str, Any]) -> list[dict[str, Any]]:
    output = []
    index = 0
    for section in ((record.get("menu") or {}).get("sections") or []):
        for item in section.get("items") or []:
            name = clean_text(item.get("name"))
            if not name:
                continue
            normalized = normalize_offer_name(name, config)
            output.append({
                "offerId": f"g{index}", "section": clean_text(section.get("name")), "name": name,
                "description": clean_text(item.get("description")), "priceText": clean_text(item.get("priceText")),
                "priceValue": number_or_none(item.get("priceValue")), "currency": clean_text(item.get("currency")),
                "baseName": normalized["base"], "variants": normalized["variants"],
            })
            index += 1
    return output


def image_items(image: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(image.get("items"), list):
        return [item for item in image["items"] if isinstance(item, dict)]
    output = []
    for section in image.get("sections") or []:
        output.extend(item for item in section.get("items") or [] if isinstance(item, dict))
    return output


def average(values: list[Any]) -> float | None:
    numbers = [number_or_none(value) for value in values]
    valid = [value for value in numbers if value is not None]
    return round(mean(valid), 6) if valid else None


def make_photo_offer(
    item: dict[str, Any], price: dict[str, Any] | None, image: dict[str, Any],
    metadata: dict[str, Any], config: dict[str, Any], offer_id: str,
    forced_reasons: list[str] | None = None,
) -> dict[str, Any]:
    name = clean_text(item.get("name")) or ""
    name_details = normalize_offer_name(name, config)
    price_label = clean_text((price or {}).get("label"))
    label_details = normalize_offer_name(price_label, config) if price_label else {"variants": {}}
    variants = merge_variants(name_details["variants"], label_details["variants"])
    human_verified = item.get("humanVerified") is True
    ocr_confidence = 1.0 if human_verified else average([
        (price or {}).get("confidence"), item.get("confidence")
    ])
    return {
        "offerId": offer_id,
        "fileName": clean_text(image.get("fileName")),
        "photoId": metadata.get("photoId"),
        "uploadDate": upload_date_text(metadata.get("uploadDate")),
        "fullSizeImageUrl": metadata.get("fullSizeImageUrl"),
        "section": clean_text(item.get("section")),
        "name": name,
        "description": clean_text(item.get("description")),
        "priceText": clean_text((price or {}).get("priceText", item.get("priceText"))),
        "priceValue": number_or_none((price or {}).get("priceValue", item.get("priceValue"))),
        "currency": clean_text((price or {}).get("currency", item.get("currency"))),
        "variant": price_label,
        "variants": variants,
        "baseName": name_details["base"],
        "ocrConfidence": ocr_confidence,
        "pairingStatus": clean_text(item.get("status")) or "success",
        "pairingConfidence": 1.0 if human_verified else number_or_none(item.get("confidence")),
        "humanVerified": human_verified,
        "evidence": item.get("evidence") or {},
        "forceReviewReasons": list(forced_reasons or []),
        "otherPhotoPrices": [],
    }


def flatten_photo_offers(
    images: list[dict[str, Any]], photo_metadata: dict[str, dict[str, Any]], config: dict[str, Any]
) -> list[dict[str, Any]]:
    output = []
    index = 0
    for image in images:
        if image.get("status") == "failed":
            continue
        photo_id = clean_text(image.get("_photoId"))
        metadata = dict(photo_metadata.get(photo_id or "") or {})
        metadata["photoId"] = photo_id
        for item in image_items(image):
            if item.get("status") == "failed" or not clean_text(item.get("name")):
                continue
            prices = [price for price in (item.get("prices") or []) if isinstance(price, dict)]
            if len(prices) > 1 and any(not clean_text(price.get("label")) for price in prices):
                offer = make_photo_offer(
                    item, None, image, metadata, config, f"p{index}", ["unlabelled_multiple_prices"]
                )
                offer["priceText"] = None
                offer["priceValue"] = None
                offer["currency"] = None
                offer["unlabelledPrices"] = [{
                    "priceText": clean_text(price.get("priceText")),
                    "priceValue": number_or_none(price.get("priceValue")),
                    "currency": clean_text(price.get("currency")),
                } for price in prices]
                output.append(offer)
                index += 1
                continue
            selected_prices = prices or [None]
            for price in selected_prices:
                output.append(make_photo_offer(item, price, image, metadata, config, f"p{index}"))
                index += 1
    return deduplicate_photo_offers(output)


def deduplicate_photo_offers(offers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for offer in offers:
        variants = json.dumps(offer.get("variants") or {}, sort_keys=True)
        groups[(offer.get("baseName") or "", variants)].append(offer)
    output = []
    for grouped in groups.values():
        file_names = [offer.get("fileName") for offer in grouped]
        if len(grouped) < 2 or len(set(file_names)) != len(grouped):
            output.extend(grouped)
            continue
        dated = [(photo_date_value(offer.get("uploadDate")), offer) for offer in grouped]
        known = [entry for entry in dated if entry[0] is not None]
        deterministic = len(known) == len(grouped)
        if deterministic:
            known.sort(key=lambda entry: (entry[0][0], entry[0][1], entry[1].get("fileName") or ""), reverse=True)
            deterministic = len(known) == 1 or known[0][0] != known[1][0]
            selected = known[0][1]
        else:
            selected = sorted(grouped, key=lambda offer: offer.get("fileName") or "")[0]
        others = [offer for offer in grouped if offer is not selected]
        selected = dict(selected)
        selected["otherPhotoPrices"] = [{
            "fileName": offer.get("fileName"), "photoId": offer.get("photoId"),
            "uploadDate": offer.get("uploadDate"), "priceText": offer.get("priceText"),
            "priceValue": offer.get("priceValue"), "currency": offer.get("currency"),
        } for offer in others]
        if not deterministic:
            selected["forceReviewReasons"].append("photo_dates_missing_or_tied")
        prices = {offer.get("priceValue") for offer in grouped if offer.get("priceValue") is not None}
        if len(prices) > 1:
            selected["forceReviewReasons"].append("conflicting_photo_prices")
        output.append(selected)
    return sorted(output, key=lambda offer: offer["offerId"])


def public_offer(offer: dict[str, Any] | None, side: str) -> dict[str, Any] | None:
    if not offer:
        return None
    common = {
        "section": offer.get("section"), "name": offer.get("name"),
        "description": offer.get("description"), "priceText": offer.get("priceText"),
        "priceValue": offer.get("priceValue"), "currency": offer.get("currency"),
    }
    if side == "photo":
        common.update({
            "fileName": offer.get("fileName"), "photoId": offer.get("photoId"),
            "uploadDate": offer.get("uploadDate"), "fullSizeImageUrl": offer.get("fullSizeImageUrl"),
            "variant": offer.get("variant"), "ocrConfidence": offer.get("ocrConfidence"),
            "pairingStatus": offer.get("pairingStatus"), "pairingConfidence": offer.get("pairingConfidence"),
            "humanVerified": offer.get("humanVerified"), "evidence": offer.get("evidence"),
            "unlabelledPrices": offer.get("unlabelledPrices"),
        })
    return common


def compare_prices(google: dict[str, Any], photo: dict[str, Any]) -> tuple[bool | None, bool, list[str]]:
    reasons = []
    if "unlabelled_multiple_prices" in photo.get("forceReviewReasons", []):
        return None, False, ["multiple_unlabelled_photo_prices"]
    google_value = number_or_none(google.get("priceValue"))
    photo_value = number_or_none(photo.get("priceValue"))
    both_currency = bool(google.get("currency") and photo.get("currency"))
    if google_value is None or photo_value is None:
        reasons.append("price_missing_or_range")
        return None, both_currency, reasons
    if both_currency and google.get("currency") != photo.get("currency"):
        reasons.append("currency_difference")
    return abs(google_value - photo_value) < 0.005, both_currency, reasons


def match_offers(
    google_offers: list[dict[str, Any]], photo_offers: list[dict[str, Any]], config: dict[str, Any]
) -> list[dict[str, Any]]:
    accept = float(config["acceptThreshold"])
    review = float(config["reviewThreshold"])
    delta = float(config["closeAlternativeDelta"])
    candidates = []
    by_google: dict[str, list[float]] = defaultdict(list)
    by_photo: dict[str, list[float]] = defaultdict(list)
    for google in google_offers:
        for photo in photo_offers:
            compatible, variant_reasons = variants_compatible(google["variants"], photo["variants"])
            if not compatible:
                continue
            score = PARSER.fuzzy_score(google["baseName"], photo["baseName"])
            if score < review:
                continue
            candidate = {"google": google, "photo": photo, "score": score, "variantReasons": variant_reasons}
            candidates.append(candidate)
            by_google[google["offerId"]].append(score)
            by_photo[photo["offerId"]].append(score)
    close_google = {key for key, scores in by_google.items()
                    if len(scores) > 1 and sorted(scores, reverse=True)[0] - sorted(scores, reverse=True)[1] <= delta}
    close_photo = {key for key, scores in by_photo.items()
                   if len(scores) > 1 and sorted(scores, reverse=True)[0] - sorted(scores, reverse=True)[1] <= delta}
    candidates.sort(key=lambda pair: (-pair["score"], pair["google"]["offerId"], pair["photo"]["offerId"]))
    used_google, used_photo, rows = set(), set(), []
    for pair in candidates:
        google, photo = pair["google"], pair["photo"]
        if google["offerId"] in used_google or photo["offerId"] in used_photo:
            continue
        used_google.add(google["offerId"])
        used_photo.add(photo["offerId"])
        reasons = list(pair["variantReasons"])
        force_review = list(photo.get("forceReviewReasons") or [])
        if google["offerId"] in close_google or photo["offerId"] in close_photo:
            force_review.append("close_alternatives")
        if photo.get("pairingStatus") == "ambiguous":
            force_review.append("ambiguous_ocr_pairing")
        price_match, currency_compared, price_reasons = compare_prices(google, photo)
        reasons.extend(price_reasons)
        reasons.extend(reason for reason in force_review if reason not in reasons)
        if pair["score"] < accept:
            reasons.append("name_in_review_band")
        if force_review or pair["score"] < accept:
            status = "REVIEW"
            name_match = None if pair["score"] < accept else True
        elif price_match is True:
            status, name_match = "MATCH", True
        elif price_match is False:
            status, name_match = "PRICE_DIFF", True
        else:
            status, name_match = "PRICE_NOT_COMPARABLE", True
        rows.append({
            "status": status, "nameMatch": name_match, "priceMatch": price_match,
            "nameScore": pair["score"], "google": public_offer(google, "google"),
            "photo": public_offer(photo, "photo"), "otherPhotoPrices": photo.get("otherPhotoPrices") or [],
            "currencyCompared": currency_compared, "reasons": list(dict.fromkeys(reasons)),
        })
    for google in google_offers:
        if google["offerId"] not in used_google:
            rows.append({
                "status": "ONLY_GOOGLE", "nameMatch": False, "priceMatch": None, "nameScore": None,
                "google": public_offer(google, "google"), "photo": None, "otherPhotoPrices": [],
                "currencyCompared": False, "reasons": [],
            })
    for photo in photo_offers:
        if photo["offerId"] not in used_photo:
            reasons = list(photo.get("forceReviewReasons") or [])
            rows.append({
                "status": "ONLY_PHOTO", "nameMatch": False, "priceMatch": None, "nameScore": None,
                "google": None, "photo": public_offer(photo, "photo"),
                "otherPhotoPrices": photo.get("otherPhotoPrices") or [], "currencyCompared": False,
                "reasons": reasons,
            })
    return rows


def calculate_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    google_total = sum(row.get("google") is not None for row in rows)
    photo_total = sum(row.get("photo") is not None for row in rows)
    paired = [row for row in rows if row.get("google") and row.get("photo")]
    comparable = [row for row in paired if isinstance(row.get("priceMatch"), bool)]
    accepted_scores = [row["nameScore"] for row in paired if row.get("nameMatch") is True and row.get("nameScore") is not None]
    confidences = [row["photo"].get("ocrConfidence") for row in paired if row["photo"].get("ocrConfidence") is not None]
    return {
        "type": "estimated",
        "googleOffers": google_total,
        "photoOffers": photo_total,
        "matchedOffers": len(paired),
        "googleCoverage": safe_divide(len(paired), google_total),
        "photoCoverage": safe_divide(len(paired), photo_total),
        "priceAgreement": safe_divide(sum(row["priceMatch"] is True for row in comparable), len(comparable)),
        "reviewRate": safe_divide(sum(row.get("status") == "REVIEW" for row in rows), len(rows)),
        "meanNameScore": round(mean(accepted_scores), 6) if accepted_scores else None,
        "meanOcrConfidence": round(mean(confidences), 6) if confidences else None,
    }


def safe_divide(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def status_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = defaultdict(int)
    for row in rows:
        counts[row["status"]] += 1
    return dict(counts)


def photo_summaries(images: list[dict[str, Any]], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for image in images:
        file_name = image.get("fileName")
        photo_rows = [row for row in rows if (row.get("photo") or {}).get("fileName") == file_name]
        output.append({
            "fileName": file_name, "photoId": image.get("_photoId"),
            "uploadDate": upload_date_text((image.get("_metadata") or {}).get("uploadDate")),
            "fullSizeImageUrl": (image.get("_metadata") or {}).get("fullSizeImageUrl"),
            "imageStatus": image.get("status"), "itemsParsed": len(image_items(image)),
            "itemsMatched": sum(row.get("google") is not None for row in photo_rows),
            "pairingAmbiguous": sum(item.get("status") == "ambiguous" for item in image_items(image)),
            "unpairedPrices": len(image.get("unpairedPrices") or []),
        })
    return output


def evaluate_ground_truth(
    places: list[dict[str, Any]], ground_truth: dict[str, Any] | None, config: dict[str, Any]
) -> dict[str, Any]:
    if not ground_truth:
        return {"status": "not_evaluated", "sampleSize": 0, "labelledAt": None}
    truth_records = []
    for place in ground_truth.get("places") or []:
        place_id = clean_text(place.get("placeId"))
        for pair in place.get("pairs") or []:
            truth_records.append({"placeId": place_id, **pair})
    truth_pairs = {truth_key(row) for row in truth_records if row.get("googleName") and row.get("photoName")}
    predicted = []
    for place in places:
        for row in place.get("items") or []:
            if row.get("google") and row.get("photo"):
                predicted.append({
                    "placeId": place.get("placeId"), "googleName": row["google"].get("name"),
                    "photoName": row["photo"].get("name"), "photoFile": row["photo"].get("fileName"),
                    "priceMatch": row.get("priceMatch"),
                })
    predicted_keys = {truth_key(row) for row in predicted}
    correct = len(predicted_keys & truth_pairs)
    precision = safe_divide(correct, len(predicted_keys))
    recall = safe_divide(correct, len(truth_pairs))
    f1 = round(2 * precision * recall / (precision + recall), 6) if precision is not None and recall is not None and precision + recall else None
    expected_verdicts = {truth_key(row): row.get("priceMatch") for row in truth_records if isinstance(row.get("priceMatch"), bool)}
    predicted_verdicts = {truth_key(row): row.get("priceMatch") for row in predicted}
    comparable_keys = [key for key in expected_verdicts if isinstance(predicted_verdicts.get(key), bool)]
    verdict_correct = sum(expected_verdicts[key] == predicted_verdicts[key] for key in comparable_keys)
    sweep = []
    for threshold_int in range(70, 96, 5):
        threshold = threshold_int / 100
        retained = {truth_key(row) for row in predicted if fuzzy_names(row) >= threshold}
        retained_correct = len(retained & truth_pairs)
        p = safe_divide(retained_correct, len(retained))
        r = safe_divide(retained_correct, len(truth_pairs))
        score = round(2 * p * r / (p + r), 6) if p is not None and r is not None and p + r else None
        sweep.append({"acceptThreshold": threshold, "precision": p, "recall": r, "f1": score})
    return {
        "status": "measured", "sampleSize": len(truth_records), "labelledAt": ground_truth.get("labelledAt"),
        "matchingPrecision": precision, "matchingRecall": recall, "matchingF1": f1,
        "verdictAccuracy": safe_divide(verdict_correct, len(comparable_keys)),
        "verdictSampleSize": len(comparable_keys), "thresholdSweep": sweep,
    }


def fuzzy_names(row: dict[str, Any]) -> float:
    return PARSER.fuzzy_score(row.get("googleName"), row.get("photoName"))


def truth_key(row: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        clean_text(row.get("placeId")) or "",
        PARSER.normalize_match_text(row.get("googleName")),
        PARSER.normalize_match_text(row.get("photoName")),
        clean_text(row.get("photoFile")) or "",
    )


def csv_rows(places: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for place in places:
        for row in place.get("items") or []:
            google, photo = row.get("google") or {}, row.get("photo") or {}
            output.append({
                "placeId": place.get("placeId"), "placeName": place.get("placeName"), "area": place.get("area"),
                "placeStatus": place.get("placeStatus"), "status": row.get("status"),
                "nameMatch": row.get("nameMatch"), "priceMatch": row.get("priceMatch"), "nameScore": row.get("nameScore"),
                "googleSection": google.get("section"), "googleName": google.get("name"),
                "googlePriceText": google.get("priceText"), "googlePriceValue": google.get("priceValue"),
                "googleCurrency": google.get("currency"), "photoFile": photo.get("fileName"),
                "photoId": photo.get("photoId"), "photoName": photo.get("name"),
                "photoPriceText": photo.get("priceText"), "photoPriceValue": photo.get("priceValue"),
                "photoCurrency": photo.get("currency"), "variant": photo.get("variant"),
                "ocrConfidence": photo.get("ocrConfidence"), "photoUploadDate": photo.get("uploadDate"),
                "photoUrl": photo.get("fullSizeImageUrl"), "currencyCompared": row.get("currencyCompared"),
                "reasons": " | ".join(row.get("reasons") or []),
            })
    return output


def write_json_atomic(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def write_csv_atomic(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = list(rows[0]) if rows else ["placeId", "placeName", "status"]
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temporary, path)


def run_matching(
    restaurants_value: Any, structured: dict[str, Any], photo_map: dict[str, dict[str, str]],
    config: dict[str, Any], ground_truth: dict[str, Any] | None = None,
) -> dict[str, Any]:
    restaurants = records_from_json(restaurants_value)
    places_by_id: dict[str, dict[str, Any]] = {}
    place_id_sources = {}
    for restaurant in restaurants:
        place_id, source = extract_place_id(restaurant)
        if not place_id:
            continue
        if place_id in places_by_id:
            raise ValueError(f"Duplicate placeId in restaurant input: {place_id}")
        places_by_id[place_id] = restaurant
        place_id_sources[place_id] = source

    linked_by_place: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unlinked = []
    explicitly_unlinked_by_place: dict[str, int] = defaultdict(int)
    for image in structured.get("images") or []:
        image = dict(image)
        link = resolve_image_link(image, photo_map)
        if not link:
            explicit_place_id = clean_text(image.get("placeId"))
            if explicit_place_id in places_by_id:
                explicitly_unlinked_by_place[explicit_place_id] += 1
            unlinked.append({
                "fileName": image.get("fileName"), "placeId": explicit_place_id,
                "photoId": clean_text(image.get("photoId")), "reason": "no_exact_photo_link",
            })
            continue
        place_id, photo_id = link["placeId"], link["photoId"]
        if place_id not in places_by_id:
            unlinked.append({"fileName": image.get("fileName"), "placeId": place_id, "photoId": photo_id,
                             "reason": "place_id_not_in_restaurant_input"})
            continue
        image["_placeId"], image["_photoId"], image["_linkSource"] = place_id, photo_id, link["source"]
        linked_by_place[place_id].append(image)

    places = []
    for place_id, restaurant in places_by_id.items():
        images = linked_by_place.get(place_id, [])
        photo_metadata = {clean_text(photo.get("photoId")) or "": photo for photo in restaurant.get("photos") or []}
        for image in images:
            image["_metadata"] = photo_metadata.get(image.get("_photoId"), {})
        google_offers = flatten_google_offers(restaurant, config)
        photo_offers = flatten_photo_offers(images, photo_metadata, config)
        items = match_offers(google_offers, photo_offers, config)
        menu_status = clean_text((restaurant.get("menuScrape") or {}).get("status"))
        if menu_status == "failed":
            place_status = "GOOGLE_MENU_FAILED"
        elif menu_status == "none":
            place_status = "NO_GOOGLE_MENU"
        elif not images and explicitly_unlinked_by_place.get(place_id):
            place_status = "PHOTOS_NOT_LINKED"
        elif not images:
            place_status = "NO_MENU_PHOTOS"
        else:
            place_status = "COMPARED"
        place = {
            "placeId": place_id, "placeIdSource": place_id_sources[place_id],
            "placeName": clean_text(restaurant.get("name")), "area": clean_text(restaurant.get("area")),
            "googleMapsUrl": clean_text(restaurant.get("googleMapsUrl")), "placeStatus": place_status,
            "items": items, "photos": photo_summaries(images, items),
            "counts": {"googleOffers": len(google_offers), "photoOffers": len(photo_offers), **status_counts(items)},
            "metrics": calculate_metrics(items),
        }
        places.append(place)

    all_rows = [row for place in places for row in place["items"]]
    result = {
        "schemaVersion": 1, "status": "complete",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "settings": {
            "acceptThreshold": config["acceptThreshold"], "reviewThreshold": config["reviewThreshold"],
            "closeAlternativeDelta": config["closeAlternativeDelta"], "assignment": "deterministic_greedy",
            "photoLinkPriority": ["structured_image", "photo_map", "filename_convention"],
        },
        "counts": {"places": len(places), "linkedImages": sum(len(place["photos"]) for place in places),
                   "unlinkedImages": len(unlinked), "itemRows": len(all_rows), **status_counts(all_rows)},
        "metrics": calculate_metrics(all_rows), "evaluation": {}, "places": places, "unlinkedImages": unlinked,
    }
    result["evaluation"] = evaluate_ground_truth(places, ground_truth, config)
    return result


def main() -> int:
    args = parse_args()
    restaurants_path = Path(args.restaurants).resolve()
    structured_path = Path(args.structured).resolve()
    photo_map_path = Path(args.photo_map).resolve() if args.photo_map else None
    config_path = Path(args.config).resolve()
    ground_truth_path = Path(args.ground_truth).resolve() if args.ground_truth else None
    output_dir = stage_output_directory(
        Path(os.environ.get("OUTPUT_ROOT", str(ROOT / "output"))),
        "menu-matching",
        explicit=args.output_dir,
        source=structured_path,
    )
    config = read_json(config_path)
    result = run_matching(
        read_json(restaurants_path), read_json(structured_path), load_photo_map(photo_map_path), config,
        read_json(ground_truth_path) if ground_truth_path else None,
    )
    result["inputFiles"] = {
        "restaurants": str(restaurants_path), "structured": str(structured_path),
        "photoMap": str(photo_map_path) if photo_map_path else None,
        "groundTruth": str(ground_truth_path) if ground_truth_path else None,
        "config": str(config_path),
    }
    write_json_atomic(typed_output(output_dir, "json", "menu-matches.json"), result)
    write_csv_atomic(typed_output(output_dir, "csv", "menu-matches.csv"), csv_rows(result["places"]))
    write_json_atomic(typed_output(output_dir, "json", "unlinked-images.json"), {
        "status": "complete", "count": len(result["unlinkedImages"]), "images": result["unlinkedImages"]
    })
    print("MENU_MATCH_SUMMARY " + json.dumps({
        "status": "complete", "places": result["counts"]["places"],
        "itemRows": result["counts"]["itemRows"], "unlinkedImages": result["counts"]["unlinkedImages"],
        "output": str(typed_output(output_dir, "json", "menu-matches.json")),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
