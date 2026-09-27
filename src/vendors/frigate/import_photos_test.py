import base64
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from PIL import Image
from import_photos import import_batch, SUPPORTED_VERSION


class PhotoImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.db = self.root / "frigate.db"
        with sqlite3.connect(self.db) as db:
            db.execute("""CREATE TABLE event (id TEXT PRIMARY KEY, camera TEXT, label TEXT, sub_label TEXT,
                start_time REAL, end_time REAL, score REAL, top_score REAL, false_positive INTEGER, zones TEXT,
                thumbnail TEXT, has_clip INTEGER, has_snapshot INTEGER, retain_indefinitely INTEGER, data TEXT)""")
        self.config = {"cameras": {"reveal": {"enabled": False, "record": {"enabled": False}}}}
        jpeg = io.BytesIO()
        Image.new("RGB", (32, 32), (50, 100, 150)).save(jpeg, "JPEG")
        self.jpeg = jpeg.getvalue()
        self.photo = {"id": "a" * 64, "camera": "reveal", "uploadedAt": 1700000000123,
            "capturedAt": "01012023123456", "jpeg": base64.b64encode(self.jpeg).decode(),
            "result": {"imageHash": hashlib.sha256(self.jpeg).hexdigest(), "processedAt": 1780000000000,
                "detections": [{"label": "animal", "score": .97, "box": [0, 0, 1, 1]}],
                "classification": {"label": "bobcat", "score": .93, "uncertain": False}}}

    def run_import(self, **overrides):
        return import_batch({"photos": [self.photo]}, overrides.get("version", SUPPORTED_VERSION), self.config, self.db, self.root / "clips")

    def test_historic_snapshot_is_idempotent_retained_and_has_no_video(self):
        self.assertEqual(self.run_import(), {"imported": ["a" * 64]})
        self.run_import()
        with sqlite3.connect(self.db) as db:
            rows = db.execute("SELECT id, label, sub_label, start_time, end_time, has_clip, has_snapshot, retain_indefinitely, data FROM event").fetchall()
        self.assertEqual(len(rows), 1)
        event = rows[0]
        self.assertEqual(event[1:8], ("animal", "bobcat", 1700000000.123, 1700000000.123, 0, 1, 1))
        self.assertEqual(json.loads(event[8])["hometruth"]["captured_at"], "01012023123456")
        self.assertEqual((self.root / "clips" / f"reveal-{event[0]}.jpg").read_bytes(), self.jpeg)
        with Image.open(self.root / "clips" / "thumbs" / "reveal" / f"{event[0]}.webp") as thumb:
            self.assertEqual(thumb.size, (32, 32))
        self.assertFalse(list(self.root.rglob("*.mp4")))
        self.assertTrue(list((self.root / "hometruth").glob("*.sqlite")))

    def test_upgrade_and_image_mismatch_fail_before_writes(self):
        with self.assertRaisesRegex(ValueError, "version changed"):
            self.run_import(version="0.18.0")
        self.photo["result"]["imageHash"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.run_import()
        self.assertFalse((self.root / "clips").exists())
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM event").fetchone()[0], 0)

    def test_owned_event_can_be_reclassified_but_not_overwrite_other_events(self):
        self.run_import()
        self.photo["result"]["classification"]["label"] = "coyote"
        self.run_import()
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT sub_label FROM event").fetchone()[0], "coyote")
            db.execute("UPDATE event SET data = '{}' ")
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.run_import()

    def test_rejects_camera_with_video_capture_or_recording(self):
        self.config["cameras"]["reveal"]["enabled"] = True
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.run_import()
        self.config["cameras"]["reveal"]["enabled"] = False
        self.config["cameras"]["reveal"]["record"]["enabled"] = True
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.run_import()


if __name__ == "__main__":
    unittest.main()
