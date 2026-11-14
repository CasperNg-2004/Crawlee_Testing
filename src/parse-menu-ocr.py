"""Convert PaddleOCR menu-photo lines into conservative structured menu items.

The parser uses layout geometry for name/price pairing. Fuzzy matching is only
an optional validation layer against a supplied typed-menu catalog; it never
replaces OCR text or invents missing prices, currencies, names, or descriptions.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from statistics import median
from typing import Any
from urllib.parse import unquote

SRC_DIRECTORY = Path(__file__).resolve().parent
if str(SRC_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SRC_DIRECTORY))
from output_paths import stage_output_directory, typed_output


PRICE_VALUE_PATTERN = re.compile(r"(?<!\d)\+?(\d{1,4}(?:[.,]\d{1,2})?)(?!\d)")
EXPLICIT_PRICE_PATTERN = re.compile(
    r"(?i)(?:\bRM\s*|\bMYR\s*)(\d{1,4}(?:[.,]\d{1,2})?)"
)
LABEL_PATTERN = re.compile(
    r"(?i)^(?:hot|iced|hot/iced|ice|single|double|base price|enjoy cup|"
    r"working cup(?:\s+or)?|(?:lovns|vns)\s+cup.*|small|medium|large|"
    r"s|m|l|oz|\d+\s*oz|step\s*\d+)$"
)
NOTE_PATTERN = re.compile(
    r"(?i)(?:prices?\s+(?:are\s+)?subject|excluding\s+sst|service\s+charge|"
    r"minutes?|choose\s+your|upgrade\s+to|scan\s+(?:me|here)|terms?\s+and)"
)
SECTION_KEYWORD_PATTERN = re.compile(
    r"(?i)(?:coffee|tea|chocolate|cocktails?|mocktails?|drinks?|desserts?|"
    r"sandwiches|patisserie|bakery|pastry|beer|wine|vodka|gin|rum|tequila|"
    r"bourbon|whisky|scotch|malt|shots?|refreshment|frappe|food|mains?|"
    r"appeti[sz]ers?|salads?|soups?|noodles?|rice|breakfast|brunch)"
)
SUPPORTED_STATUSES = {"success", "none", "failed"}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")

    args = parse_args()
    input_path = Path(args.input).resolve()
    source = read_json(input_path)
    source_images, source_info = parser_images_from_source(source, input_path)

    typed_catalog = load_typed_catalog(args.typed_menu)
    ground_truth = load_ground_truth(args.ground_truth)
    unpaired_labels = load_unpaired_labels(args.unpaired_labels)
    output_dir = stage_output_directory(
        Path(os.environ.get("OUTPUT_ROOT", "output")),
        "menu-parsing",
        explicit=args.output_dir,
        source=input_path,
    )

    started = time.perf_counter()
    parsed_images = []
    for index, image in enumerate(source_images, start=1):
        file_name = str(image.get("fileName") or f"image-{index}")
        parsed = parse_image(
            image,
            typed_catalog.get(file_name, []),
            unpaired_labels,
            minimum_pair_confidence=args.minimum_pair_confidence,
            fuzzy_threshold=args.fuzzy_threshold,
        )
        parsed_images.append(parsed)
        print(
            f"[{index}/{len(source_images)}] {file_name}: "
            f"items={parsed['counts']['items']} "
            f"ambiguous={parsed['counts']['ambiguousItems']} "
            f"unpairedPrices={parsed['counts']['unpairedPriceLines']}",
            flush=True,
        )

    evaluation = evaluate(parsed_images, ground_truth)
    report = {
        "schemaVersion": 1,
        "status": "complete",
        "createdAt": iso_now(),
        "inputPath": str(input_path),
        "settings": {
            "minimumPairConfidence": args.minimum_pair_confidence,
            "fuzzyThreshold": args.fuzzy_threshold,
            "typedMenuPath": str(Path(args.typed_menu).resolve())
            if args.typed_menu
            else None,
            "groundTruthPath": str(Path(args.ground_truth).resolve())
            if args.ground_truth
            else None,
            "unpairedLabelsPath": str(Path(args.unpaired_labels).resolve())
            if args.unpaired_labels
            else None,
            "pairingMethod": "column_aware_spatial_price_anchor",
            "fuzzyMatchingPurpose": "optional_typed_menu_validation_only",
            **source_info,
        },
        "counts": aggregate_counts(parsed_images),
        "evaluation": evaluation,
        "images": parsed_images,
        "elapsedSeconds": round(time.perf_counter() - started, 3),
    }

    ambiguous = flatten_ambiguous(parsed_images)
    unpaired = flatten_unpaired(parsed_images)
    template = ground_truth_template(parsed_images)
    write_json(typed_output(output_dir, "json", "structured-menu.json"), report)
    write_structured_csv(typed_output(output_dir, "csv", "structured-menu.csv"), parsed_images)
    write_json(typed_output(output_dir, "json", "ambiguous-items.json"), ambiguous)
    write_json(typed_output(output_dir, "json", "unpaired-lines.json"), unpaired)
    write_json(typed_output(output_dir, "json", "evaluation.json"), evaluation)
    write_json(typed_output(output_dir, "json", "ground-truth-template.json"), template)

    summary = {
        "status": report["status"],
        **report["counts"],
        "evaluationStatus": evaluation["status"],
        "elapsedSeconds": report["elapsedSeconds"],
        "output": str(typed_output(output_dir, "json", "structured-menu.json")),
    }
    print("MENU_OCR_PARSE_SUMMARY " + json.dumps(summary, ensure_ascii=False))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pair saved PaddleOCR menu text and prices using layout geometry."
    )
    parser.add_argument(
        "input",
        help=(
            "PaddleOCR paddleocr-analysis.json or integrated "
            "photo-classification photo-analysis.json file."
        ),
    )
    parser.add_argument("--output-dir", help="Directory for structured outputs.")
    parser.add_argument(
        "--typed-menu",
        help="Optional JSON catalog used only for fuzzy name validation.",
    )
    parser.add_argument(
        "--ground-truth",
        help="Optional human-verified JSON for correct/wrong/missed metrics.",
    )
    parser.add_argument(
        "--unpaired-labels",
        help="Optional labels saved by the unpaired menu-price labeller.",
    )
    parser.add_argument(
        "--minimum-pair-confidence", type=ratio, default=0.58
    )
    parser.add_argument("--fuzzy-threshold", type=ratio, default=0.82)
    return parser.parse_args()


def parser_images_from_source(
    source: dict[str, Any], input_path: Path
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if isinstance(source.get("images"), list):
        return source["images"], {
            "inputFormat": "standalone_paddleocr",
            "photoLabelsPath": None,
            "photoSelection": "all_source_images",
        }

    restaurants = source.get("restaurants")
    if not isinstance(restaurants, list):
        raise SystemExit(
            f"{input_path} must contain either a PaddleOCR images array or "
            "photo-classification restaurants array."
        )

    labels_path = input_path.parent.parent / "csv" / "photo-analysis-labels.csv"
    labels = load_photo_category_labels(labels_path)
    use_manual_labels = bool(labels)
    images: list[dict[str, Any]] = []
    for restaurant in restaurants:
        place_id = classification_place_id(restaurant)
        restaurant_name = clean_text(restaurant.get("name"))
        for image in restaurant.get("images") or []:
            photo_id = clean_text(image.get("photoId"))
            actual_category = labels.get(photo_id or "")
            selected = (
                actual_category == "menu"
                if use_manual_labels
                else image.get("category") == "menu"
            )
            if not selected:
                continue
            ocr = image.get("ocr") if isinstance(image.get("ocr"), dict) else {}
            ocr_status = ocr.get("status")
            if ocr_status not in SUPPORTED_STATUSES:
                ocr_status = "failed"
            error = ocr.get("error")
            if not ocr:
                error = (
                    "OCR was not run because this manually confirmed menu photo "
                    "was not selected as menu by the classifier."
                )
            file_name = (
                f"{place_id}__{photo_id}.jpg"
                if place_id and photo_id
                else f"{photo_id or 'unknown-photo'}.jpg"
            )
            images.append(
                {
                    "inputPath": image.get("originalFullSizeImageUrl")
                    or image.get("analysisImageUrl"),
                    "fileName": file_name,
                    "restaurantName": restaurant_name,
                    "placeId": place_id,
                    "photoId": photo_id,
                    "status": ocr_status,
                    "elapsedSeconds": ocr.get("elapsedSeconds"),
                    "lineCount": len(ocr.get("lines") or []),
                    "meanConfidence": ocr.get("confidence"),
                    "text": ocr.get("text"),
                    "lines": ocr.get("lines") or [],
                    "priceCandidates": ocr.get("priceCandidates") or [],
                    "error": error,
                }
            )

    return images, {
        "inputFormat": "integrated_photo_classification",
        "photoLabelsPath": str(labels_path) if use_manual_labels else None,
        "photoSelection": "manual_menu_labels" if use_manual_labels else "predicted_menu",
    }


def load_photo_category_labels(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle)
        return {
            clean_text(row.get("photoId")) or "":
            (clean_text(row.get("actualCategory")) or "").lower()
            for row in rows
            if clean_text(row.get("photoId"))
            and clean_text(row.get("actualCategory"))
        }


def classification_place_id(restaurant: dict[str, Any]) -> str | None:
    explicit = clean_text(restaurant.get("placeId"))
    if explicit:
        return explicit
    maps_url = clean_text(restaurant.get("googleMapsUrl"))
    if not maps_url:
        return None
    match = re.search(r"(?:!19s|%2119s)(ChIJ[^!&/?%]+)", maps_url)
    return unquote(match.group(1)) if match else None


def parse_image(
    image: dict[str, Any],
    typed_items: list[dict[str, Any]],
    unpaired_labels: dict[str, dict[str, Any]] | None = None,
    minimum_pair_confidence: float = 0.58,
    fuzzy_threshold: float = 0.82,
) -> dict[str, Any]:
    file_name = str(image.get("fileName") or "unknown")
    if image.get("status") not in {None, "success", "none"}:
        return empty_image_result(file_name, image, "failed", image.get("error"))

    lines = normalize_lines(image)
    if not lines:
        return empty_image_result(file_name, image, "none", None)

    canvas_width = max((line["x2"] for line in lines), default=1.0)
    canvas_height = max((line["y2"] for line in lines), default=1.0)
    typical_height = median(
        [line["height"] for line in lines if line["height"] > 0]
    )
    price_lines = [line for line in lines if line["prices"]]
    if not price_lines:
        result = empty_image_result(file_name, image, "none", None)
        result["counts"]["ocrLines"] = len(lines)
        result["unpairedTextLines"] = [line_evidence(line) for line in lines]
        return result

    for price_line in price_lines:
        usable, reason = price_anchor_quality(price_line, canvas_width)
        price_line["priceAnchorUsable"] = usable
        price_line["priceAnchorReason"] = reason
    pairable_price_lines = [line for line in price_lines if line["priceAnchorUsable"]]
    clusters = cluster_price_columns(pairable_price_lines, canvas_width)
    assignments: dict[int, dict[str, Any]] = {}
    candidate_details: dict[int, list[dict[str, Any]]] = {}
    for price_line in pairable_price_lines:
        cluster = clusters[price_line["clusterId"]]
        candidates = score_name_candidates(
            price_line,
            lines,
            cluster,
            canvas_width,
            typical_height,
        )
        candidate_details[price_line["index"]] = candidates[:3]
        if not candidates or candidates[0]["score"] < minimum_pair_confidence:
            continue
        best = candidates[0]
        ambiguous = len(candidates) > 1 and best["score"] - candidates[1]["score"] < 0.06
        assignments[price_line["index"]] = {
            "nameLineIndex": best["lineIndex"],
            "score": best["score"],
            "pairingMethod": best["pairingMethod"],
            "ambiguous": ambiguous,
            "alternatives": candidates[1:3] if ambiguous else [],
        }

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for price_line in pairable_price_lines:
        assignment = assignments.get(price_line["index"])
        if assignment:
            grouped[assignment["nameLineIndex"]].append(price_line)

    assigned_name_indexes = set(grouped)
    price_indexes = {line["index"] for line in price_lines}
    items = []
    line_by_index = {line["index"]: line for line in lines}
    for name_index, anchors in grouped.items():
        name_line = line_by_index[name_index]
        assignment_rows = [assignments[anchor["index"]] for anchor in anchors]
        pairing_methods = {row["pairingMethod"] for row in assignment_rows}
        name_lines = [name_line]
        if "stacked_price_below_name" in pairing_methods:
            name_lines = expand_stacked_name_lines(
                name_line, lines, canvas_width, typical_height
            )
            assigned_name_indexes.update(line["index"] for line in name_lines)
        combined_name_line = combine_name_lines(name_lines)
        display_name = " ".join(line["text"] for line in name_lines)
        pairing_confidence = round(
            sum(row["score"] for row in assignment_rows) / len(assignment_rows), 6
        )
        ambiguous = any(row["ambiguous"] for row in assignment_rows)
        prices = []
        for anchor in sorted(anchors, key=lambda row: (row["cy"], row["cx"])):
            for price in anchor["prices"]:
                prices.append(
                    {
                        **price,
                        "label": None,
                        "lineIndex": anchor["index"],
                        "lineText": anchor["text"],
                        "confidence": anchor["confidence"],
                        "box": anchor["box"],
                    }
                )
        prices = deduplicate_prices(prices)
        item = {
            "section": None,
            "name": display_name,
            "description": None,
            "priceText": prices[0]["priceText"] if len(prices) == 1 else None,
            "priceValue": prices[0]["priceValue"] if len(prices) == 1 else None,
            "currency": prices[0]["currency"] if len(prices) == 1 else None,
            "prices": prices,
            "status": "ambiguous" if ambiguous else "success",
            "confidence": pairing_confidence,
            "typedMenuMatch": fuzzy_typed_match(
                display_name, typed_items, fuzzy_threshold
            ),
            "evidence": {
                "pairingMethod": assignment_rows[0]["pairingMethod"]
                if len(pairing_methods) == 1
                else "mixed_spatial_methods",
                "pairingMethods": sorted(pairing_methods),
                "nameLineIndexes": [line["index"] for line in name_lines],
                "descriptionLineIndexes": [],
                "priceLineIndexes": sorted(anchor["index"] for anchor in anchors),
                "nameBox": combined_name_line["box"],
                "alternativeNameCandidates": merge_alternatives(assignment_rows),
            },
            "_clusterId": anchors[0]["clusterId"],
            "_nameLine": combined_name_line,
        }
        items.append(item)

    items.sort(key=lambda item: (item["_clusterId"], item["_nameLine"]["cy"]))
    section_indexes: set[int] = set()
    description_indexes: set[int] = set()
    attach_sections_and_descriptions(
        items,
        lines,
        assigned_name_indexes,
        price_indexes,
        canvas_width,
        typical_height,
        section_indexes,
        description_indexes,
    )

    for item in items:
        item.pop("_clusterId", None)
        item.pop("_nameLine", None)

    unpaired_prices = []
    for price_line in price_lines:
        if price_line["index"] in assignments:
            continue
        unpaired_prices.append(
            {
                "lineIndex": price_line["index"],
                "lineText": price_line["text"],
                "box": price_line["box"],
                "prices": price_line["prices"],
                "reason": price_line.get("priceAnchorReason")
                if not price_line.get("priceAnchorUsable", True)
                else "no_reliable_name_candidate",
                "candidateNames": candidate_details.get(price_line["index"], []),
            }
        )

    review_counts = apply_unpaired_labels(
        file_name, items, unpaired_prices, unpaired_labels or {}
    )

    used_indexes = (
        assigned_name_indexes | price_indexes | section_indexes | description_indexes
    )
    unpaired_text = [
        line_evidence(line) for line in lines if line["index"] not in used_indexes
    ]
    sections = group_sections(items)
    image_status = "success"
    if (
        review_counts["unresolved"]
        or any(item["status"] == "ambiguous" for item in items)
    ):
        image_status = "partial"
    if not items:
        image_status = "partial"

    return {
        "fileName": file_name,
        "inputPath": image.get("inputPath"),
        "restaurantName": image.get("restaurantName"),
        "placeId": image.get("placeId"),
        "photoId": image.get("photoId"),
        "status": image_status,
        "canvas": {
            "ocrExtentWidth": round(canvas_width, 3),
            "ocrExtentHeight": round(canvas_height, 3),
            "medianLineHeight": round(typical_height, 3),
            "priceColumns": [
                {
                    "id": cluster["id"],
                    "centerX": round(cluster["centerX"], 3),
                    "priceLineCount": len(cluster["lines"]),
                }
                for cluster in clusters
            ],
        },
        "sections": sections,
        "items": items,
        "unpairedPrices": unpaired_prices,
        "unpairedTextLines": unpaired_text,
        "counts": {
            "ocrLines": len(lines),
            "priceCandidates": sum(len(line["prices"]) for line in price_lines),
            "priceLines": len(price_lines),
            "priceColumns": len(clusters),
            "items": len(items),
            "successfulItems": sum(item["status"] == "success" for item in items),
            "ambiguousItems": sum(item["status"] == "ambiguous" for item in items),
            "totalUnpairedPriceLines": len(unpaired_prices),
            "reviewedUnpairedPriceLines": review_counts["reviewed"],
            "resolvedUnpairedPriceLines": review_counts["resolved"],
            "verifiedCorrections": review_counts["corrections"],
            "unpairedPriceLines": review_counts["unresolved"],
            "unpairedTextLines": len(unpaired_text),
        },
        "error": None,
    }


def normalize_lines(image: dict[str, Any]) -> list[dict[str, Any]]:
    price_by_line: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for candidate in image.get("priceCandidates") or []:
        line_index = candidate.get("lineIndex")
        if not isinstance(line_index, int):
            continue
        value = number_or_none(candidate.get("priceValue"))
        if value is None or value <= 0 or value > 5000:
            continue
        price_by_line[line_index].append(
            {
                "priceText": str(candidate.get("priceText") or "").strip() or None,
                "priceValue": value,
                "currency": candidate.get("currency") or None,
                "reason": candidate.get("reason") or "source_candidate",
            }
        )

    normalized = []
    for index, source in enumerate(image.get("lines") or []):
        box = normalize_box(source.get("box"))
        text = clean_text(source.get("text"))
        if not text or box is None:
            continue
        x1, y1, x2, y2 = box
        prices = merge_price_candidates(
            price_by_line.get(index) or [], infer_prices(text)
        )
        normalized.append(
            {
                "index": index,
                "text": text,
                "confidence": number_or_none(source.get("confidence")),
                "box": [round(value, 3) for value in box],
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "cx": (x1 + x2) / 2,
                "cy": (y1 + y2) / 2,
                "width": max(x2 - x1, 1.0),
                "height": max(y2 - y1, 1.0),
                "prices": prices,
                "clusterId": None,
            }
        )
    # Source lineIndex values refer to the original ordered array. Keeping all
    # valid Paddle boxes means list position normally equals source index; use a
    # map in the rare case an invalid source line was skipped.
    by_source_index = {line["index"]: line for line in normalized}
    return [by_source_index[index] for index in sorted(by_source_index)]


def cluster_price_columns(
    price_lines: list[dict[str, Any]], canvas_width: float
) -> list[dict[str, Any]]:
    tolerance = max(80.0, canvas_width * 0.065)
    clusters: list[dict[str, Any]] = []
    for line in sorted(price_lines, key=lambda row: row["cx"]):
        best = None
        best_distance = float("inf")
        for cluster in clusters:
            distance = abs(line["cx"] - cluster["centerX"])
            if distance <= tolerance and distance < best_distance:
                best = cluster
                best_distance = distance
        if best is None:
            best = {"id": len(clusters), "centerX": line["cx"], "lines": []}
            clusters.append(best)
        best["lines"].append(line)
        best["centerX"] = sum(row["cx"] for row in best["lines"]) / len(best["lines"])
    clusters.sort(key=lambda cluster: cluster["centerX"])
    for cluster_id, cluster in enumerate(clusters):
        cluster["id"] = cluster_id
        cluster["leftBoundary"] = (
            clusters[cluster_id - 1]["centerX"] if cluster_id > 0 else 0.0
        )
        for line in cluster["lines"]:
            line["clusterId"] = cluster_id
    return clusters


def score_name_candidates(
    price_line: dict[str, Any],
    lines: list[dict[str, Any]],
    cluster: dict[str, Any],
    canvas_width: float,
    typical_height: float,
) -> list[dict[str, Any]]:
    scored_by_line: dict[int, dict[str, Any]] = {}
    vertical_limit = max(typical_height * 1.8, price_line["height"] * 1.5)
    for line in lines:
        if line["index"] == price_line["index"] or line["prices"]:
            continue
        quality = name_quality(line["text"], line["height"], typical_height)
        if quality <= 0:
            continue
        confidence = line["confidence"] if line["confidence"] is not None else 0.5
        vertical_distance = abs(line["cy"] - price_line["cy"])
        horizontal_gap = price_line["x1"] - line["x2"]
        if (
            vertical_distance <= vertical_limit
            and horizontal_gap >= -canvas_width * 0.005
            and horizontal_gap <= canvas_width * 0.42
            and line["x1"] >= cluster.get("leftBoundary", 0) - canvas_width * 0.02
        ):
            vertical_score = 1 - min(vertical_distance / vertical_limit, 1)
            gap_score = 1 - min(max(horizontal_gap, 0) / (canvas_width * 0.35), 1)
            score = round(
                0.5 * vertical_score
                + 0.2 * gap_score
                + 0.2 * quality
                + 0.1 * confidence,
                6,
            )
            scored_by_line[line["index"]] = {
                "lineIndex": line["index"],
                "text": line["text"],
                "score": score,
                "pairingMethod": "same_row_left_of_price",
                "verticalDistance": round(vertical_distance, 3),
                "horizontalGap": round(horizontal_gap, 3),
                "box": line["box"],
            }

        stacked_distance = price_line["cy"] - line["cy"]
        start_distance = abs(price_line["x1"] - line["x1"])
        stacked_limit = typical_height * 8.0
        if (
            is_stacked_name_candidate(line["text"], line["height"], typical_height)
            and
            stacked_distance > 0
            and stacked_distance <= stacked_limit
            and start_distance <= canvas_width * 0.025
        ):
            vertical_score = 1 - min(stacked_distance / stacked_limit, 1)
            alignment_score = 1 - min(start_distance / (canvas_width * 0.025), 1)
            score = round(min(
                0.4 * vertical_score
                + 0.2 * alignment_score
                + 0.3 * quality
                + 0.1 * confidence
                + 0.15 * alignment_score,
                1.0,
            ), 6)
            existing = scored_by_line.get(line["index"])
            candidate = {
                "lineIndex": line["index"],
                "text": line["text"],
                "score": score,
                "pairingMethod": "stacked_price_below_name",
                "verticalDistance": round(stacked_distance, 3),
                "horizontalGap": round(start_distance, 3),
                "box": line["box"],
            }
            if existing is None or score > existing["score"]:
                scored_by_line[line["index"]] = candidate
    return sorted(
        scored_by_line.values(),
        key=lambda row: (-row["score"], row["horizontalGap"]),
    )


def attach_sections_and_descriptions(
    items: list[dict[str, Any]],
    lines: list[dict[str, Any]],
    name_indexes: set[int],
    price_indexes: set[int],
    canvas_width: float,
    typical_height: float,
    section_indexes: set[int],
    description_indexes: set[int],
) -> None:
    by_cluster: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_cluster[item["_clusterId"]].append(item)

    excluded = name_indexes | price_indexes
    for cluster_items in by_cluster.values():
        cluster_items.sort(key=lambda item: item["_nameLine"]["cy"])
        previous_name_y = None
        current_section = None
        for position, item in enumerate(cluster_items):
            name_line = item["_nameLine"]
            next_name_y = (
                cluster_items[position + 1]["_nameLine"]["y1"]
                if position + 1 < len(cluster_items)
                else name_line["y2"] + typical_height * 5
            )

            section_floor = (
                previous_name_y if previous_name_y is not None else name_line["y1"] - typical_height * 7
            )
            possible_sections = [
                line
                for line in lines
                if line["index"] not in excluded
                and line["index"] not in description_indexes
                and section_floor < line["cy"] < name_line["cy"]
                and abs(line["x1"] - name_line["x1"]) <= canvas_width * 0.18
                and is_section_like(line["text"], line["height"], typical_height)
            ]
            if possible_sections:
                section_line = min(
                    possible_sections,
                    key=lambda line: (
                        3 * abs(line["x1"] - name_line["x1"]) / canvas_width
                        + abs(name_line["cy"] - line["cy"])
                        / max(typical_height * 15, 1)
                    ),
                )
                current_section = section_line["text"]
                section_indexes.add(section_line["index"])
            elif (
                previous_name_y is not None
                and name_line["cy"] - previous_name_y > typical_height * 3.0
            ):
                current_section = None
            item["section"] = current_section

            possible_descriptions = []
            if item["evidence"]["pairingMethod"] == "same_row_left_of_price":
                possible_descriptions = [
                    line
                    for line in lines
                    if line["index"] not in excluded
                    and line["index"] not in section_indexes
                    and name_line["y2"] < line["cy"] < next_name_y
                    and line["x1"] >= name_line["x1"] - canvas_width * 0.025
                    and line["x1"] <= name_line["x1"] + canvas_width * 0.16
                    and is_description_like(line["text"], line["height"], name_line["height"], typical_height)
                ]
            possible_descriptions.sort(key=lambda line: (line["cy"], line["cx"]))
            if possible_descriptions:
                item["description"] = " ".join(line["text"] for line in possible_descriptions)
                indexes = [line["index"] for line in possible_descriptions]
                item["evidence"]["descriptionLineIndexes"] = indexes
                description_indexes.update(indexes)
            previous_name_y = name_line["cy"]


def name_quality(text: str, height: float, typical_height: float) -> float:
    letters = [character for character in text if character.isalpha()]
    if len(letters) < 2 or len(text) > 90:
        return 0.0
    if LABEL_PATTERN.match(text.strip()) or NOTE_PATTERN.search(text):
        return 0.0
    if text.count(",") >= 2 or (text.endswith(".") and len(text) > 18):
        return 0.0
    digits = sum(character.isdigit() for character in text)
    if digits > max(3, len(text) * 0.35):
        return 0.0
    uppercase_ratio = sum(character.isupper() for character in letters) / len(letters)
    lowercase_ratio = sum(character.islower() for character in letters) / len(letters)
    if lowercase_ratio > 0.75 and len(text) > 35:
        return 0.0
    word_count = len(text.split())
    if word_count > 12:
        return 0.0
    size_score = min(height / max(typical_height, 1), 1.25) / 1.25
    case_score = 0.95 if uppercase_ratio >= 0.7 else 0.72
    length_score = 1.0 if 2 <= word_count <= 7 else 0.7
    return round(0.4 * case_score + 0.35 * size_score + 0.25 * length_score, 6)


def is_section_like(text: str, height: float, typical_height: float) -> bool:
    letters = [character for character in text if character.isalpha()]
    if len(letters) < 3 or len(text) > 60 or len(text.split()) > 7:
        return False
    if LABEL_PATTERN.match(text) or NOTE_PATTERN.search(text) or "," in text:
        return False
    uppercase_ratio = sum(character.isupper() for character in letters) / len(letters)
    return (
        uppercase_ratio >= 0.72
        and (
            height >= typical_height * 1.55
            or SECTION_KEYWORD_PATTERN.search(text) is not None
        )
    )


def is_description_like(
    text: str, height: float, name_height: float, typical_height: float
) -> bool:
    if len(text) < 6 or LABEL_PATTERN.match(text) or NOTE_PATTERN.search(text):
        return False
    letters = [character for character in text if character.isalpha()]
    if not letters:
        return False
    uppercase_ratio = sum(character.isupper() for character in letters) / len(letters)
    sentence_signal = any(character in text for character in ",.;") or uppercase_ratio < 0.72
    return sentence_signal and height <= max(name_height * 1.35, typical_height * 1.35)


def is_stacked_name_candidate(
    text: str, height: float, typical_height: float
) -> bool:
    letters = [character for character in text if character.isalpha()]
    if not letters or len(text) > 55 or "," in text or text.endswith("."):
        return False
    if LABEL_PATTERN.match(text) or NOTE_PATTERN.search(text):
        return False
    uppercase_ratio = sum(character.isupper() for character in letters) / len(letters)
    return uppercase_ratio >= 0.72 and height >= typical_height * 0.72


def expand_stacked_name_lines(
    primary: dict[str, Any],
    lines: list[dict[str, Any]],
    canvas_width: float,
    typical_height: float,
) -> list[dict[str, Any]]:
    candidates = [
        line
        for line in lines
        if not line["prices"]
        and abs(line["x1"] - primary["x1"]) <= canvas_width * 0.03
        and abs(line["cy"] - primary["cy"]) <= typical_height * 1.8
        and is_stacked_name_candidate(line["text"], line["height"], typical_height)
    ]
    candidates.sort(key=lambda line: line["cy"])
    if primary not in candidates:
        candidates.append(primary)
        candidates.sort(key=lambda line: line["cy"])
    primary_position = candidates.index(primary)
    selected = [primary]

    for direction in (-1, 1):
        position = primary_position + direction
        previous = primary
        while 0 <= position < len(candidates) and len(selected) < 3:
            candidate = candidates[position]
            gap = (
                previous["y1"] - candidate["y2"]
                if direction < 0
                else candidate["y1"] - previous["y2"]
            )
            if gap > typical_height * 0.25:
                break
            selected.append(candidate)
            previous = candidate
            position += direction
    return sorted({line["index"]: line for line in selected}.values(), key=lambda line: line["cy"])


def combine_name_lines(lines: list[dict[str, Any]]) -> dict[str, Any]:
    if len(lines) == 1:
        return lines[0]
    x1 = min(line["x1"] for line in lines)
    y1 = min(line["y1"] for line in lines)
    x2 = max(line["x2"] for line in lines)
    y2 = max(line["y2"] for line in lines)
    combined = dict(lines[0])
    combined.update(
        {
            "text": " ".join(line["text"] for line in lines),
            "box": [x1, y1, x2, y2],
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "cx": (x1 + x2) / 2,
            "cy": (y1 + y2) / 2,
            "width": x2 - x1,
            "height": y2 - y1,
        }
    )
    return combined


def price_anchor_quality(
    line: dict[str, Any], canvas_width: float
) -> tuple[bool, str]:
    confidence = line.get("confidence")
    numeric_only = all(price.get("currency") is None for price in line["prices"])
    if numeric_only and confidence is not None and confidence < 0.80:
        return False, "low_confidence_numeric_only_line"
    if numeric_only and all(
        (price.get("priceValue") or 0) > 700 for price in line["prices"]
    ):
        return False, "numeric_only_value_outlier"

    remainder = EXPLICIT_PRICE_PATTERN.sub(" ", line["text"])
    if numeric_only and re.fullmatch(r"[+\d\s.,/|-]+", line["text"].strip()):
        remainder = PRICE_VALUE_PATTERN.sub(" ", line["text"])
    remainder = re.sub(r"[+|/()\-:.,\d\s]+", " ", remainder).strip()
    if remainder:
        normalized_remainder = re.sub(r"(?i)\bC?RM\b", " ", remainder)
        normalized_remainder = re.sub(r"\s+", " ", normalized_remainder).strip()
        allowed = re.fullmatch(
            r"(?i)(?:(?:base\s+price|hot|iced|small|medium|large|s|m|l|"
            r"for|per|gls|glass)\s*)+",
            normalized_remainder,
        )
        if not allowed:
            return False, "mixed_non_price_text"
    return True, "usable_price_anchor"


def infer_prices(text: str) -> list[dict[str, Any]]:
    normalized_text = re.sub(r"(?i)\bCRM(?=\s*\d)", "RM", text)
    explicit = list(EXPLICIT_PRICE_PATTERN.finditer(normalized_text))
    if explicit:
        return [
            make_price(match.group(0), match.group(1), "MYR", "explicit_currency")
            for match in explicit
        ]
    stripped = normalized_text.strip()
    if not re.fullmatch(r"[+\d\s.,/|-]+", stripped):
        return []
    return [
        make_price(match.group(0), match.group(1), None, "numeric_only")
        for match in PRICE_VALUE_PATTERN.finditer(stripped)
    ]


def make_price(
    price_text: str, numeric_text: str, currency: str | None, reason: str
) -> dict[str, Any]:
    value = number_or_none(numeric_text.lstrip("+").replace(",", "."))
    return {
        "priceText": price_text.strip(),
        "priceValue": value,
        "currency": currency,
        "reason": reason,
    }


def deduplicate_prices(prices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    output = []
    for price in prices:
        key = (
            price.get("lineIndex"),
            price.get("priceText"),
            price.get("priceValue"),
            price.get("currency"),
        )
        if key in seen:
            continue
        seen.add(key)
        output.append(price)
    return output


def merge_price_candidates(
    source: list[dict[str, Any]], inferred: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Merge OCR-provided and locally recovered prices without duplication."""
    output = []
    seen = set()
    for price in [*source, *inferred]:
        value = number_or_none(price.get("priceValue"))
        if value is None or value <= 0 or value > 5000:
            continue
        key = (round(value, 2), price.get("currency") or None)
        if key in seen:
            continue
        seen.add(key)
        output.append(
            {
                "priceText": price.get("priceText"),
                "priceValue": value,
                "currency": price.get("currency") or None,
                "reason": price.get("reason") or "inferred_candidate",
            }
        )
    return output


def fuzzy_typed_match(
    name: str, typed_items: list[dict[str, Any]], threshold: float
) -> dict[str, Any] | None:
    best = None
    for typed in typed_items:
        typed_name = clean_text(typed.get("name"))
        if not typed_name:
            continue
        score = fuzzy_score(name, typed_name)
        if best is None or score > best["score"]:
            best = {
                "name": typed_name,
                "section": typed.get("section") or None,
                "score": score,
            }
    return best if best and best["score"] >= threshold else None


def fuzzy_score(left: str, right: str) -> float:
    left_normal = normalize_match_text(left)
    right_normal = normalize_match_text(right)
    if not left_normal or not right_normal:
        return 0.0
    sequence = SequenceMatcher(None, left_normal, right_normal).ratio()
    token_sequence = SequenceMatcher(
        None,
        " ".join(sorted(left_normal.split())),
        " ".join(sorted(right_normal.split())),
    ).ratio()
    return round(max(sequence, token_sequence), 6)


def load_typed_catalog(path: str | None) -> dict[str, list[dict[str, Any]]]:
    if not path:
        return {}
    data = read_json(Path(path))
    if isinstance(data.get("images"), dict):
        return {
            str(file_name): normalize_typed_items(items)
            for file_name, items in data["images"].items()
        }
    records = data.get("images") if isinstance(data.get("images"), list) else data
    catalog: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if isinstance(records, list):
        for record in records:
            file_name = str(record.get("fileName") or "")
            if file_name:
                catalog[file_name].extend(normalize_typed_items(record.get("items") or []))
    return dict(catalog)


def normalize_typed_items(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        {"name": clean_text(item.get("name")), "section": item.get("section")}
        for item in items
        if isinstance(item, dict) and clean_text(item.get("name"))
    ]


def load_ground_truth(path: str | None) -> dict[str, dict[str, Any]]:
    if not path:
        return {}
    data = read_json(Path(path))
    records = data.get("images") if isinstance(data, dict) else data
    if not isinstance(records, list):
        return {}
    return {
        str(record.get("fileName")): record
        for record in records
        if isinstance(record, dict) and record.get("fileName")
    }


def load_unpaired_labels(path: str | None) -> dict[str, dict[str, Any]]:
    if not path:
        return {}
    data = read_json(Path(path))
    records = data.get("labels") if isinstance(data, dict) else data
    if not isinstance(records, list):
        return {}
    return {
        str(record.get("key")): record
        for record in records
        if isinstance(record, dict) and record.get("key")
    }


def apply_unpaired_labels(
    file_name: str,
    items: list[dict[str, Any]],
    unpaired_prices: list[dict[str, Any]],
    labels: dict[str, dict[str, Any]],
) -> dict[str, int]:
    actionable = {"item_price", "price_variant", "addon_price", "bundle_price"}
    resolved_categories = actionable | {"not_a_price", "duplicate"}
    reviewed = 0
    resolved = 0
    corrections = 0
    for row in unpaired_prices:
        key = f"{file_name}::{row['lineIndex']}"
        label = labels.get(key)
        row["reviewKey"] = key
        row["reviewLabel"] = label
        row["resolved"] = False
        if not label:
            continue
        reviewed += 1
        category = str(label.get("category") or "").strip().lower()
        if category in resolved_categories:
            resolved += 1
            row["resolved"] = True
        if category in actionable and apply_verified_unpaired_price(items, row, label):
            corrections += 1
    return {
        "reviewed": reviewed,
        "resolved": resolved,
        "corrections": corrections,
        "unresolved": len(unpaired_prices) - resolved,
    }


def apply_verified_unpaired_price(
    items: list[dict[str, Any]],
    source_row: dict[str, Any],
    label: dict[str, Any],
) -> bool:
    name = clean_text(label.get("itemName"))
    price_text = clean_text(label.get("priceText"))
    price_value = number_or_none(label.get("priceValue"))
    if not name or not price_text or price_value is None or price_value <= 0:
        return False
    category = str(label.get("category") or "").strip().lower()
    price = {
        "label": clean_text(label.get("variantLabel")),
        "priceText": price_text,
        "priceValue": price_value,
        "currency": clean_text(label.get("currency")),
        "reason": "human_verified_unpaired",
        "lineIndex": source_row.get("lineIndex"),
        "lineText": source_row.get("lineText"),
        "confidence": 1.0,
        "box": source_row.get("box"),
        "verificationCategory": category,
    }
    normalized_name = normalize_match_text(name)
    existing = next(
        (
            item
            for item in items
            if normalize_match_text(item.get("name")) == normalized_name
        ),
        None,
    )
    verification = {
        "category": category,
        "reviewKey": label.get("key"),
        "reviewedAt": label.get("reviewedAt"),
        "notes": clean_text(label.get("notes")),
    }
    if existing is not None:
        keys = {
            (
                item_price.get("priceText"),
                item_price.get("priceValue"),
                item_price.get("currency"),
                item_price.get("label"),
            )
            for item_price in existing.get("prices") or []
        }
        price_key = (
            price["priceText"],
            price["priceValue"],
            price["currency"],
            price["label"],
        )
        if price_key not in keys:
            existing.setdefault("prices", []).append(price)
        if clean_text(label.get("section")):
            existing["section"] = clean_text(label.get("section"))
        if clean_text(label.get("description")):
            existing["description"] = clean_text(label.get("description"))
        existing["humanVerified"] = True
        existing.setdefault("humanVerifications", []).append(verification)
        existing["status"] = "success"
        existing["confidence"] = 1.0
        existing.setdefault("evidence", {}).setdefault(
            "verifiedUnpairedLineIndexes", []
        ).append(source_row.get("lineIndex"))
        refresh_single_price_fields(existing)
        return True

    item = {
        "section": clean_text(label.get("section")),
        "name": name,
        "description": clean_text(label.get("description")),
        "priceText": price_text,
        "priceValue": price_value,
        "currency": price["currency"],
        "prices": [price],
        "status": "success",
        "confidence": 1.0,
        "typedMenuMatch": None,
        "humanVerified": True,
        "humanVerifications": [verification],
        "evidence": {
            "pairingMethod": "human_verified_unpaired",
            "pairingMethods": ["human_verified_unpaired"],
            "nameLineIndexes": [],
            "descriptionLineIndexes": [],
            "priceLineIndexes": [source_row.get("lineIndex")],
            "verifiedUnpairedLineIndexes": [source_row.get("lineIndex")],
            "nameBox": None,
            "alternativeNameCandidates": [],
        },
    }
    items.append(item)
    return True


def refresh_single_price_fields(item: dict[str, Any]) -> None:
    prices = item.get("prices") or []
    item["priceText"] = prices[0].get("priceText") if len(prices) == 1 else None
    item["priceValue"] = prices[0].get("priceValue") if len(prices) == 1 else None
    item["currency"] = prices[0].get("currency") if len(prices) == 1 else None


def evaluate(
    images: list[dict[str, Any]], ground_truth: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    evaluated = []
    totals = Counter()
    for image in images:
        truth = ground_truth.get(image["fileName"])
        if not truth:
            continue
        expected = price_counter(truth.get("expectedPrices") or [])
        predicted = price_counter(
            price["priceValue"]
            for item in image.get("items") or []
            for price in item.get("prices") or []
        )
        correct = sum((expected & predicted).values())
        wrong = sum((predicted - expected).values())
        missed = sum((expected - predicted).values())
        pair_metrics = evaluate_pairs(image.get("items") or [], truth.get("items") or [])
        result = {
            "fileName": image["fileName"],
            "expectedPrices": sum(expected.values()),
            "predictedPrices": sum(predicted.values()),
            "correctPrices": correct,
            "wrongPrices": wrong,
            "missedPrices": missed,
            **pair_metrics,
        }
        evaluated.append(result)
        totals.update({key: value for key, value in result.items() if isinstance(value, int)})
    if not evaluated:
        return {
            "status": "not_evaluated",
            "evaluatedImages": 0,
            "correctPrices": None,
            "wrongPrices": None,
            "missedPrices": None,
            "pricePrecision": None,
            "priceRecall": None,
            "correctNamePricePairs": None,
            "wrongNamePricePairs": None,
            "missedNamePricePairs": None,
            "images": [],
            "note": "Fill ground-truth-template.json and pass it with --ground-truth.",
        }
    correct = totals["correctPrices"]
    wrong = totals["wrongPrices"]
    missed = totals["missedPrices"]
    return {
        "status": "evaluated",
        "evaluatedImages": len(evaluated),
        "correctPrices": correct,
        "wrongPrices": wrong,
        "missedPrices": missed,
        "pricePrecision": safe_divide(correct, correct + wrong),
        "priceRecall": safe_divide(correct, correct + missed),
        "correctNamePricePairs": totals["correctNamePricePairs"],
        "wrongNamePricePairs": totals["wrongNamePricePairs"],
        "missedNamePricePairs": totals["missedNamePricePairs"],
        "images": evaluated,
        "note": "Metrics use only manually verified ground-truth images.",
    }


def evaluate_pairs(
    predicted_items: list[dict[str, Any]], expected_items: list[dict[str, Any]]
) -> dict[str, int]:
    if not expected_items:
        return {
            "correctNamePricePairs": 0,
            "wrongNamePricePairs": 0,
            "missedNamePricePairs": 0,
        }
    used = set()
    correct = 0
    missed = 0
    for expected in expected_items:
        expected_name = clean_text(expected.get("name"))
        expected_prices = price_counter(expected.get("prices") or [])
        candidates = [
            (index, fuzzy_score(expected_name, item.get("name") or ""), item)
            for index, item in enumerate(predicted_items)
            if index not in used
        ]
        candidates.sort(key=lambda row: row[1], reverse=True)
        if not candidates or candidates[0][1] < 0.78:
            missed += 1
            continue
        index, _, predicted = candidates[0]
        predicted_prices = price_counter(
            price.get("priceValue") for price in predicted.get("prices") or []
        )
        if expected_prices == predicted_prices:
            correct += 1
            used.add(index)
        else:
            missed += 1
    wrong = len(predicted_items) - len(used)
    return {
        "correctNamePricePairs": correct,
        "wrongNamePricePairs": wrong,
        "missedNamePricePairs": missed,
    }


def aggregate_counts(images: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "images": len(images),
        "imagesSuccess": sum(image["status"] == "success" for image in images),
        "imagesPartial": sum(image["status"] == "partial" for image in images),
        "imagesNone": sum(image["status"] == "none" for image in images),
        "imagesFailed": sum(image["status"] == "failed" for image in images),
        "items": sum(image["counts"]["items"] for image in images),
        "successfulItems": sum(
            image["counts"]["successfulItems"] for image in images
        ),
        "ambiguousItems": sum(
            image["counts"]["ambiguousItems"] for image in images
        ),
        "priceCandidates": sum(
            image["counts"]["priceCandidates"] for image in images
        ),
        "totalUnpairedPriceLines": sum(
            image["counts"]["totalUnpairedPriceLines"] for image in images
        ),
        "reviewedUnpairedPriceLines": sum(
            image["counts"]["reviewedUnpairedPriceLines"] for image in images
        ),
        "resolvedUnpairedPriceLines": sum(
            image["counts"]["resolvedUnpairedPriceLines"] for image in images
        ),
        "verifiedCorrections": sum(
            image["counts"]["verifiedCorrections"] for image in images
        ),
        "unpairedPriceLines": sum(
            image["counts"]["unpairedPriceLines"] for image in images
        ),
    }


def group_sections(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        key = item.get("section") or "Unsectioned"
        groups.setdefault(key, []).append(item)
    return [{"name": name if name != "Unsectioned" else None, "items": rows} for name, rows in groups.items()]


def flatten_ambiguous(images: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [
        {"fileName": image["fileName"], **item}
        for image in images
        for item in image.get("items") or []
        if item.get("status") == "ambiguous"
    ]
    return {"count": len(rows), "items": rows}


def flatten_unpaired(images: list[dict[str, Any]]) -> dict[str, Any]:
    price_rows = [
        {"fileName": image["fileName"], **row}
        for image in images
        for row in image.get("unpairedPrices") or []
    ]
    text_rows = [
        {"fileName": image["fileName"], **row}
        for image in images
        for row in image.get("unpairedTextLines") or []
    ]
    return {
        "unpairedPriceLineCount": len(price_rows),
        "unpairedTextLineCount": len(text_rows),
        "unpairedPrices": price_rows,
        "unpairedTextLines": text_rows,
    }


def ground_truth_template(images: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "instructions": (
            "Enter only human-verified visible prices and name/price pairs. "
            "Do not copy parser predictions without checking the source photo."
        ),
        "images": [
            {"fileName": image["fileName"], "expectedPrices": [], "items": []}
            for image in images
        ],
    }


def empty_image_result(
    file_name: str, source: dict[str, Any], status: str, error: Any
) -> dict[str, Any]:
    return {
        "fileName": file_name,
        "inputPath": source.get("inputPath"),
        "restaurantName": source.get("restaurantName"),
        "placeId": source.get("placeId"),
        "photoId": source.get("photoId"),
        "status": status if status in SUPPORTED_STATUSES else "failed",
        "canvas": None,
        "sections": [],
        "items": [],
        "unpairedPrices": [],
        "unpairedTextLines": [],
        "counts": {
            "ocrLines": 0,
            "priceCandidates": 0,
            "priceLines": 0,
            "priceColumns": 0,
            "items": 0,
            "successfulItems": 0,
            "ambiguousItems": 0,
            "totalUnpairedPriceLines": 0,
            "reviewedUnpairedPriceLines": 0,
            "resolvedUnpairedPriceLines": 0,
            "verifiedCorrections": 0,
            "unpairedPriceLines": 0,
            "unpairedTextLines": 0,
        },
        "error": str(error) if error else None,
    }


def line_evidence(line: dict[str, Any]) -> dict[str, Any]:
    return {
        "lineIndex": line["index"],
        "text": line["text"],
        "confidence": line["confidence"],
        "box": line["box"],
    }


def merge_alternatives(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    output = []
    for row in rows:
        for candidate in row.get("alternatives") or []:
            key = candidate["lineIndex"]
            if key in seen:
                continue
            seen.add(key)
            output.append(candidate)
    return output


def price_counter(values: Any) -> Counter:
    counter = Counter()
    for value in values:
        if isinstance(value, dict):
            value = value.get("priceValue", value.get("value"))
        number = number_or_none(value)
        if number is not None:
            counter[round(number, 2)] += 1
    return counter


def normalize_box(value: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(value, list) or len(value) < 4:
        return None
    numbers = [number_or_none(part) for part in value[:4]]
    if any(part is None for part in numbers):
        return None
    x1, y1, x2, y2 = numbers
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def normalize_match_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def clean_text(value: Any) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text or None


def number_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def ratio(value: str) -> float:
    number = float(value)
    if not 0 <= number <= 1:
        raise argparse.ArgumentTypeError("must be between zero and one")
    return number


def safe_divide(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def write_structured_csv(path: Path, images: list[dict[str, Any]]) -> None:
    fields = [
        "fileName",
        "section",
        "name",
        "description",
        "status",
        "confidence",
        "pairingMethod",
        "priceLabel",
        "priceText",
        "priceValue",
        "currency",
        "typedMenuName",
        "typedMenuScore",
        "nameLineIndexes",
        "priceLineIndexes",
    ]
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for image in images:
            for item in image.get("items") or []:
                prices = item.get("prices") or [None]
                for price in prices:
                    typed = item.get("typedMenuMatch") or {}
                    evidence = item.get("evidence") or {}
                    writer.writerow(
                        {
                            "fileName": image.get("fileName"),
                            "section": item.get("section"),
                            "name": item.get("name"),
                            "description": item.get("description"),
                            "status": item.get("status"),
                            "confidence": item.get("confidence"),
                            "pairingMethod": evidence.get("pairingMethod"),
                            "priceLabel": price.get("label") if price else None,
                            "priceText": price.get("priceText") if price else None,
                            "priceValue": price.get("priceValue") if price else None,
                            "currency": price.get("currency") if price else None,
                            "typedMenuName": typed.get("name"),
                            "typedMenuScore": typed.get("score"),
                            "nameLineIndexes": "|".join(
                                str(value) for value in evidence.get("nameLineIndexes") or []
                            ),
                            "priceLineIndexes": "|".join(
                                str(value) for value in evidence.get("priceLineIndexes") or []
                            ),
                        }
                    )
    temporary.replace(path)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    raise SystemExit(main())
