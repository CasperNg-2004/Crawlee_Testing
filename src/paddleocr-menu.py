"""Independent PaddleOCR menu-photo benchmark.

This runner does not modify the main Tesseract photo-analysis pipeline. It
preserves PaddleOCR text boxes and confidence so menu rows can later be paired
with prices without guessing missing data.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SRC_DIRECTORY = Path(__file__).resolve().parent
if str(SRC_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SRC_DIRECTORY))
from output_paths import stage_output_directory, typed_output


IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
MODEL_NAMES = {
    "tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec"),
    "small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
}
RM_PRICE_PATTERN = re.compile(r"(?i)(?:\bRM\s*|\bMYR\s*)(\d{1,4}(?:[.,]\d{1,2})?)")
PLAIN_PRICE_PATTERN = re.compile(r"(?<!\d)(\+?\d{1,3}(?:[.,]\d{1,2})?)(?!\d)")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")

    args = parse_args()
    if args.worker:
        return run_worker(args)

    input_path = Path(args.input).resolve()
    image_paths = collect_images(input_path, args.limit)
    if not image_paths:
        raise SystemExit(f"No supported images found at {input_path}")

    output_dir = stage_output_directory(
        Path("output") / "photo-analysis",
        "paddleocr",
        explicit=args.output_dir,
    )
    visualization_dir = output_dir / "other" / "visualizations"
    if args.save_visualizations:
        visualization_dir.mkdir(parents=True, exist_ok=True)

    started_at = iso_now()
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "running",
        "startedAt": started_at,
        "finishedAt": None,
        "inputPath": str(input_path),
        "outputDirectory": str(output_dir),
        "settings": {
            "paddleOcrVersion": package_version("paddleocr"),
            "paddlePaddleVersion": package_version("paddlepaddle"),
            "modelSize": args.model_size,
            "detectionModel": MODEL_NAMES[args.model_size][0],
            "recognitionModel": MODEL_NAMES[args.model_size][1],
            "device": "cpu",
            "cpuThreads": args.cpu_threads,
            "mkldnnEnabled": False,
            "orientationEnabled": not args.no_orientation,
            "unwarpingEnabled": False,
            "maximumImageSide": args.max_side,
            "minimumTextConfidence": args.text_score,
        },
        "timing": {
            "modelStartupSeconds": None,
            "imageProcessingSeconds": None,
            "meanSecondsPerImage": None,
            "medianSecondsPerImage": None,
            "totalSeconds": None,
        },
        "counts": {
            "requestedImages": len(image_paths),
            "successfulImages": 0,
            "failedImages": 0,
            "recognizedLines": 0,
            "priceCandidates": 0,
        },
        "images": [],
    }
    write_json(typed_output(output_dir, "json", "paddleocr-analysis.partial.json"), report)

    overall_started = time.perf_counter()
    pipeline_started = time.perf_counter()
    pipeline = create_pipeline(args)
    report["timing"]["modelStartupSeconds"] = round(
        time.perf_counter() - pipeline_started, 3
    )

    image_times: list[float] = []
    for index, image_path in enumerate(image_paths, start=1):
        print(f"[{index}/{len(image_paths)}] {image_path.name}", flush=True)
        image_started = time.perf_counter()
        try:
            predictions = list(
                pipeline.predict(
                    str(image_path),
                    use_doc_orientation_classify=not args.no_orientation,
                    use_doc_unwarping=False,
                    use_textline_orientation=not args.no_orientation,
                    text_det_limit_side_len=args.max_side,
                    text_det_limit_type="max",
                    text_rec_score_thresh=args.text_score,
                )
            )
            elapsed = round(time.perf_counter() - image_started, 3)
            image_times.append(elapsed)
            image_result = normalize_predictions(image_path, predictions, elapsed)
            if args.save_visualizations:
                save_visualizations(predictions, visualization_dir)
        except Exception as error:  # Paddle errors vary by inference backend.
            elapsed = round(time.perf_counter() - image_started, 3)
            image_times.append(elapsed)
            image_result = {
                "inputPath": str(image_path),
                "fileName": image_path.name,
                "status": "failed",
                "elapsedSeconds": elapsed,
                "lineCount": 0,
                "meanConfidence": None,
                "text": None,
                "lines": [],
                "priceCandidates": [],
                "error": concise_error(error),
            }

        report["images"].append(image_result)
        refresh_counts(report)
        write_json(typed_output(output_dir, "json", "paddleocr-analysis.partial.json"), report)
        print(
            f"  {image_result['status']} lines={image_result['lineCount']} "
            f"prices={len(image_result['priceCandidates'])} "
            f"elapsed={image_result['elapsedSeconds']:.3f}s",
            flush=True,
        )

    report["status"] = (
        "complete" if report["counts"]["failedImages"] == 0 else "partial"
    )
    report["finishedAt"] = iso_now()
    report["timing"]["imageProcessingSeconds"] = round(sum(image_times), 3)
    report["timing"]["meanSecondsPerImage"] = round(
        sum(image_times) / len(image_times), 3
    )
    report["timing"]["medianSecondsPerImage"] = round(median(image_times), 3)
    report["timing"]["totalSeconds"] = round(
        time.perf_counter() - overall_started, 3
    )
    refresh_counts(report)
    write_json(typed_output(output_dir, "json", "paddleocr-analysis.json"), report)
    write_json(typed_output(output_dir, "json", "paddleocr-analysis.partial.json"), report)

    print(
        "PADDLEOCR_SUMMARY "
        + json.dumps(
            {
                "status": report["status"],
                **report["counts"],
                **report["timing"],
                "output": str(typed_output(output_dir, "json", "paddleocr-analysis.json")),
            },
            ensure_ascii=False,
        )
    )
    return 0 if report["counts"]["failedImages"] == 0 else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run isolated PaddleOCR on menu photos and save layout-aware JSON."
    )
    parser.add_argument(
        "input",
        nargs="?",
        help="Image file or directory containing menu photos.",
    )
    parser.add_argument("--output-dir", help="Output directory for JSON and visualizations.")
    parser.add_argument("--limit", type=positive_integer, default=None)
    parser.add_argument("--model-size", choices=MODEL_NAMES, default="small")
    parser.add_argument("--cpu-threads", type=positive_integer, default=4)
    parser.add_argument("--max-side", type=positive_integer, default=1800)
    parser.add_argument("--text-score", type=confidence, default=0.35)
    parser.add_argument("--no-orientation", action="store_true")
    parser.add_argument("--save-visualizations", action="store_true")
    parser.add_argument(
        "--worker",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()
    if not args.worker and not args.input:
        parser.error("input is required unless --worker is used")
    return args


def run_worker(args: argparse.Namespace) -> int:
    """Keep one PaddleOCR pipeline alive for JSON-line requests from Node.js."""
    pipeline = create_pipeline(args)
    print(
        "PADDLEOCR_WORKER_READY "
        + json.dumps(
            {
                "modelSize": args.model_size,
                "detectionModel": MODEL_NAMES[args.model_size][0],
                "recognitionModel": MODEL_NAMES[args.model_size][1],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    for raw_line in sys.stdin:
        request_id: Any = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            if request.get("action") == "shutdown":
                break
            if request.get("action") != "recognize":
                raise ValueError("Unsupported PaddleOCR worker action.")
            image_path = Path(request["inputPath"]).resolve()
            started = time.perf_counter()
            predictions = list(
                pipeline.predict(
                    str(image_path),
                    use_doc_orientation_classify=not args.no_orientation,
                    use_doc_unwarping=False,
                    use_textline_orientation=not args.no_orientation,
                    text_det_limit_side_len=args.max_side,
                    text_det_limit_type="max",
                    text_rec_score_thresh=args.text_score,
                )
            )
            elapsed = round(time.perf_counter() - started, 3)
            result = normalize_predictions(image_path, predictions, elapsed)
        except Exception as error:  # Keep the worker alive after one bad image.
            result = {
                "status": "failed",
                "elapsedSeconds": None,
                "lineCount": 0,
                "meanConfidence": None,
                "text": None,
                "lines": [],
                "priceCandidates": [],
                "error": concise_error(error),
            }
        print(
            "PADDLEOCR_WORKER_RESULT "
            + json.dumps({"id": request_id, "result": result}, ensure_ascii=False),
            flush=True,
        )
    return 0


def create_pipeline(args: argparse.Namespace) -> Any:
    try:
        from paddleocr import PaddleOCR
    except ImportError as error:
        raise SystemExit(
            "PaddleOCR is not installed. Run `npm run setup:paddleocr` first."
        ) from error

    detection_model, recognition_model = MODEL_NAMES[args.model_size]
    return PaddleOCR(
        text_detection_model_name=detection_model,
        text_recognition_model_name=recognition_model,
        use_doc_orientation_classify=not args.no_orientation,
        use_doc_unwarping=False,
        use_textline_orientation=not args.no_orientation,
        device="cpu",
        engine="paddle_static",
        # PaddlePaddle 3.3.1 on Windows currently fails PP-OCRv6 execution with
        # oneDNN enabled (ConvertPirAttribute2RuntimeAttribute). The regular CPU
        # executor is slower but stable and keeps this benchmark reproducible.
        enable_mkldnn=False,
        cpu_threads=args.cpu_threads,
    )


def normalize_predictions(
    image_path: Path, predictions: list[Any], elapsed: float
) -> dict[str, Any]:
    lines: list[dict[str, Any]] = []
    for prediction in predictions:
        payload = prediction.json
        if callable(payload):
            payload = payload()
        result = payload.get("res", payload)
        texts = to_list(result.get("rec_texts"))
        scores = to_list(result.get("rec_scores"))
        boxes = to_list(result.get("rec_boxes"))
        polygons = to_list(result.get("rec_polys"))
        for index, text in enumerate(texts):
            cleaned = clean_text(text)
            if not cleaned:
                continue
            confidence_value = number_or_none(value_at(scores, index))
            box = value_at(boxes, index)
            polygon = value_at(polygons, index)
            lines.append(
                {
                    "text": cleaned,
                    "confidence": confidence_value,
                    "box": json_value(box),
                    "polygon": json_value(polygon),
                }
            )

    lines.sort(key=line_sort_key)
    price_candidates: list[dict[str, Any]] = []
    for line_index, line in enumerate(lines):
        for candidate in price_candidates_from_line(line["text"]):
            price_candidates.append(
                {
                    **candidate,
                    "lineIndex": line_index,
                    "lineText": line["text"],
                    "confidence": line["confidence"],
                    "box": line["box"],
                }
            )

    confidences = [
        line["confidence"] for line in lines if line["confidence"] is not None
    ]
    return {
        "inputPath": str(image_path),
        "fileName": image_path.name,
        "status": "success" if lines else "none",
        "elapsedSeconds": elapsed,
        "lineCount": len(lines),
        "meanConfidence": (
            round(sum(confidences) / len(confidences), 6) if confidences else None
        ),
        "text": "\n".join(line["text"] for line in lines) or None,
        "lines": lines,
        "priceCandidates": price_candidates,
        "error": None,
    }


def price_candidates_from_line(text: str) -> list[dict[str, Any]]:
    explicit_matches = list(RM_PRICE_PATTERN.finditer(text))
    if explicit_matches:
        return [
            price_candidate(match.group(0), match.group(1), "MYR", "explicit_currency")
            for match in explicit_matches
        ]

    stripped = text.strip()
    if not re.fullmatch(r"[+\d\s.,/|-]+", stripped):
        return []
    return [
        price_candidate(match.group(0), match.group(1), None, "numeric_only")
        for match in PLAIN_PRICE_PATTERN.finditer(stripped)
    ]


def price_candidate(
    price_text: str, numeric_text: str, currency: str | None, reason: str
) -> dict[str, Any]:
    normalized = numeric_text.lstrip("+").replace(",", ".")
    try:
        value = float(normalized)
    except ValueError:
        value = None
    return {
        "priceText": price_text.strip(),
        "priceValue": value,
        "currency": currency,
        "reason": reason,
    }


def collect_images(path: Path, limit: int | None) -> list[Path]:
    if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
        images = [path]
    elif path.is_dir():
        images = sorted(
            candidate
            for candidate in path.iterdir()
            if candidate.is_file() and candidate.suffix.lower() in IMAGE_EXTENSIONS
        )
    else:
        images = []
    return images[:limit] if limit else images


def save_visualizations(predictions: list[Any], directory: Path) -> None:
    for prediction in predictions:
        prediction.save_to_img(str(directory))


def refresh_counts(report: dict[str, Any]) -> None:
    images = report["images"]
    report["counts"].update(
        {
            "successfulImages": sum(image["status"] != "failed" for image in images),
            "failedImages": sum(image["status"] == "failed" for image in images),
            "recognizedLines": sum(image["lineCount"] for image in images),
            "priceCandidates": sum(
                len(image["priceCandidates"]) for image in images
            ),
        }
    )


def line_sort_key(line: dict[str, Any]) -> tuple[float, float]:
    box = line.get("box")
    if isinstance(box, list) and len(box) >= 4:
        return float(box[1]), float(box[0])
    return float("inf"), float("inf")


def to_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value) if isinstance(value, (list, tuple)) else [value]


def value_at(values: list[Any], index: int) -> Any:
    return values[index] if index < len(values) else None


def json_value(value: Any) -> Any:
    if hasattr(value, "tolist"):
        return value.tolist()
    if isinstance(value, tuple):
        return list(value)
    return value


def number_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 6)


def clean_text(value: Any) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text or None


def median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def write_json(path: Path, value: Any) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary_path.replace(path)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def package_version(name: str) -> str | None:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return None


def positive_integer(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return number


def confidence(value: str) -> float:
    number = float(value)
    if not 0 <= number <= 1:
        raise argparse.ArgumentTypeError("must be between zero and one")
    return number


def concise_error(error: Exception) -> str:
    return re.sub(r"\s+", " ", str(error)).strip()[:500] or error.__class__.__name__


if __name__ == "__main__":
    raise SystemExit(main())
