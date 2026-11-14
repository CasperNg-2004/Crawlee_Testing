import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from output_paths import create_job_root, stage_output_directory, typed_output


class OutputPathsTests(unittest.TestCase):
    def test_creates_stage_types_and_reuses_source_job(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "test") as temporary:
            root = Path(temporary)
            job = create_job_root(root, datetime(2026, 11, 14, 9, 8, 7))
            self.assertEqual(job, root / "Running#1")
            paddle = stage_output_directory(
                root,
                "paddleocr",
                source=None,
                explicit=str(job / "photo-analysis" / "paddleocr"),
            )
            source = typed_output(paddle, "json", "paddleocr-analysis.json")
            source.write_text("{}\n", encoding="utf-8")

            parser = stage_output_directory(root, "menu-parsing", source=source)
            self.assertEqual(parser, job / "photo-analysis" / "menu-parsing")
            for output_type in ("json", "csv", "xlsx", "other"):
                self.assertTrue((parser / output_type).is_dir())


if __name__ == "__main__":
    unittest.main()
