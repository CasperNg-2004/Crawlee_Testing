"""Shared numbered pipeline output layout for the photo-analysis tools."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path


OUTPUT_TYPES = ("json", "csv", "xlsx", "other")
PHOTO_ANALYSIS_STAGES = ("paddleocr", "menu-parsing", "menu-matching")
PIPELINE_STAGES = ("scraper", "photo-classification", "photo-analysis")


def create_job_root(base_directory: Path, now: datetime | None = None) -> Path:
    del now  # Kept in the signature for compatibility with older callers/tests.
    root = base_directory.resolve()
    root.mkdir(parents=True, exist_ok=True)
    existing_numbers = [
        int(path.name.split("#", 1)[1])
        for path in root.iterdir()
        if path.is_dir()
        and path.name.lower().startswith("running#")
        and path.name.split("#", 1)[1].isdigit()
    ]
    first_number = max(existing_numbers, default=0) + 1
    for number in range(first_number, first_number + 100):
        candidate = root / f"Running#{number}"
        try:
            candidate.mkdir()
            for pipeline_stage in PIPELINE_STAGES:
                (candidate / pipeline_stage).mkdir()
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError(f"Could not create a unique numbered run under {root}.")


def latest_pipeline_run(base_directory: Path) -> Path | None:
    root = base_directory.resolve()
    if not root.exists():
        return None
    candidates = []
    for path in root.iterdir():
        if not path.is_dir() or not path.name.lower().startswith("running#"):
            continue
        suffix = path.name.split("#", 1)[1]
        if suffix.isdigit():
            candidates.append((int(suffix), path))
    return max(candidates, default=(0, None), key=lambda item: item[0])[1]


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

    job_root = job_root_from_source(source) if source else latest_pipeline_run(base_directory)
    if job_root is None:
        job_root = create_job_root(base_directory)
    return ensure_stage_output(job_root / "photo-analysis" / stage)


def job_root_from_source(source: Path | None) -> Path | None:
    if source is None:
        return None
    resolved = source.resolve()
    for parent in (resolved.parent, *resolved.parents):
        if parent.name.lower().startswith("running#") and parent.name.split("#", 1)[1].isdigit():
            return parent
        if parent.name in PHOTO_ANALYSIS_STAGES:
            analysis_root = parent.parent
            if analysis_root.name == "photo-analysis" and analysis_root.parent.name.lower().startswith("running#"):
                return analysis_root.parent
    return None


def typed_output(stage_directory: Path, output_type: str, filename: str) -> Path:
    if output_type not in OUTPUT_TYPES:
        raise ValueError(f"Unknown output type: {output_type}")
    return stage_directory / output_type / filename
