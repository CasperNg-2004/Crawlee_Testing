"""Shared dated/type-based output layout for the photo-analysis tools."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path


OUTPUT_TYPES = ("json", "csv", "xlsx", "other")
PHOTO_ANALYSIS_STAGES = ("paddleocr", "menu-parsing", "menu-matching")


def create_job_root(base_directory: Path, now: datetime | None = None) -> Path:
    moment = now or datetime.now()
    date_directory = base_directory.resolve() / moment.strftime("%Y-%m-%d")
    date_directory.mkdir(parents=True, exist_ok=True)
    time_name = moment.strftime("%H-%M-%S")
    for suffix in range(100):
        name = time_name if suffix == 0 else f"{time_name}-{suffix:02d}"
        candidate = date_directory / name
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError(f"Could not create a unique output run under {date_directory}.")


def ensure_stage_output(stage_directory: Path) -> Path:
    root = stage_directory.resolve()
    root.mkdir(parents=True, exist_ok=True)
    for output_type in OUTPUT_TYPES:
        (root / output_type).mkdir(exist_ok=True)
    return root


def stage_output_directory(
    base_directory: Path,
    stage: str,
    *,
    explicit: str | None = None,
    source: Path | None = None,
) -> Path:
    if stage not in PHOTO_ANALYSIS_STAGES:
        raise ValueError(f"Unknown photo-analysis stage: {stage}")
    if explicit:
        return ensure_stage_output(Path(explicit))

    job_root = job_root_from_source(source) if source else None
    if job_root is None:
        job_root = create_job_root(base_directory)
    return ensure_stage_output(job_root / stage)


def job_root_from_source(source: Path | None) -> Path | None:
    if source is None:
        return None
    resolved = source.resolve()
    for parent in (resolved.parent, *resolved.parents):
        if parent.name in PHOTO_ANALYSIS_STAGES:
            return parent.parent
    return None


def typed_output(stage_directory: Path, output_type: str, filename: str) -> Path:
    if output_type not in OUTPUT_TYPES:
        raise ValueError(f"Unknown output type: {output_type}")
    return stage_directory / output_type / filename
