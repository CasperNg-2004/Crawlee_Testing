#!/usr/bin/env python3
"""Build an exact fileName/placeId/photoId map without name matching."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", required=True, help="JSON or CSV image selection file")
    parser.add_argument("--photo-list", required=True, help="JSON or CSV exported photo list")
    parser.add_argument("--output", default=None, help="Output CSV path")
    return parser.parse_args()


def load_rows(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            return [dict(row) for row in csv.DictReader(handle)]
    value = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    for key in ("rows", "photos", "images", "records"):
        if isinstance(value, dict) and isinstance(value.get(key), list):
            return [row for row in value[key] if isinstance(row, dict)]
    return [value] if isinstance(value, dict) else []


def first_value(row: dict[str, Any], *keys: str) -> str | None:
    lowered = {str(key).lower(): value for key, value in row.items()}
    for key in keys:
        value = lowered.get(key.lower())
        text = str(value or "").strip()
        if text:
            return text
    return None


def build_photo_map(
    selection_rows: list[dict[str, Any]], photo_rows: list[dict[str, Any]]
) -> list[dict[str, str]]:
    photos_by_id: dict[str, dict[str, str]] = {}
    conflicts: set[str] = set()
    for row in photo_rows:
        photo_id = first_value(row, "photoId", "photo_id")
        place_id = first_value(row, "placeId", "place_id")
        if not photo_id or not place_id:
            continue
        existing = photos_by_id.get(photo_id)
        if existing and existing["placeId"] != place_id:
            conflicts.add(photo_id)
            continue
        photos_by_id[photo_id] = {"placeId": place_id, "photoId": photo_id}

    if conflicts:
        joined = ", ".join(sorted(conflicts)[:5])
        raise ValueError(f"Photo IDs map to more than one place: {joined}")

    output: list[dict[str, str]] = []
    seen_files: dict[str, tuple[str, str]] = {}
    missing: list[str] = []
    for row in selection_rows:
        file_name = first_value(row, "fileName", "imageFile", "file", "image")
        photo_id = first_value(row, "photoId", "photo_id")
        explicit_place = first_value(row, "placeId", "place_id")
        linked = photos_by_id.get(photo_id or "")
        place_id = explicit_place or (linked["placeId"] if linked else None)
        if not file_name or not photo_id or not place_id:
            missing.append(file_name or photo_id or "<unknown row>")
            continue
        identity = (place_id, photo_id)
        if file_name in seen_files and seen_files[file_name] != identity:
            raise ValueError(f"File name maps to conflicting photos: {file_name}")
        seen_files[file_name] = identity
        output.append({"fileName": file_name, "placeId": place_id, "photoId": photo_id})

    if missing:
        joined = ", ".join(missing[:5])
        raise ValueError(f"Could not link {len(missing)} selection row(s): {joined}")
    return sorted(output, key=lambda row: row["fileName"].lower())


def write_csv_atomic(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["fileName", "placeId", "photoId"])
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temporary, path)


def main() -> int:
    args = parse_args()
    selection_path = Path(args.selection).resolve()
    photo_list_path = Path(args.photo_list).resolve()
    output_path = Path(args.output).resolve() if args.output else selection_path.with_name("photo-map.csv")
    rows = build_photo_map(load_rows(selection_path), load_rows(photo_list_path))
    write_csv_atomic(output_path, rows)
    print(f"PHOTO_MAP_SUMMARY {json.dumps({'status': 'complete', 'rows': len(rows), 'output': str(output_path)})}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
