"""HomeTruth snapshot importer for Frigate 0.17.2 (no video or fake motion).

Installed at /config/hometruth/import_photos.py. Uses Frigate's snapshot/event
layout because its public create-event API cannot import historical JPEGs.
Fail closed on upgrades; revalidate schema/media/UI before supporting a version.
Input/output is bounded JSON over authenticated SSH, never a network listener.
"""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import urllib.request

from PIL import Image

SUPPORTED_VERSION = "0.17.2-3d4dd3a"
OWNER = "hometruth-reveal-v1"
MAX_INPUT = 32 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def label(value):
    require(isinstance(value, str) and 0 < len(value) <= 200 and not re.search(r"[\x00-\x1f]", value), "Invalid label")
    value = value.strip().lower().replace("_", " ")
    return {"human": "person", "blank": "no detection", "no cv result": "unclassified"}.get(value, value)


def score(value):
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1, "Invalid score")
    return value


def prepare(photo, config):
    photo_id, camera = photo.get("id"), photo.get("camera")
    require(isinstance(photo_id, str) and re.fullmatch(r"[a-f0-9]{64}", photo_id), "Invalid photo ID")
    require(isinstance(camera, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,19}", camera), "Invalid camera")
    camera_config = config.get("cameras", {}).get(camera)
    require(camera_config and camera_config.get("enabled") is False and camera_config.get("record", {}).get("enabled") is False,
            "Photo camera must be configured with capture and recording disabled")
    result = photo["result"]
    jpeg = base64.b64decode(photo["jpeg"], validate=True)
    require(0 < len(jpeg) <= 20 * 1024 * 1024, "Invalid photo size")
    require(hashlib.sha256(jpeg).hexdigest() == result["imageHash"], "Photo does not match inference")
    with Image.open(io.BytesIO(jpeg)) as image:
        require(image.format == "JPEG", "Expected JPEG")
        image.load()
        image.thumbnail((512, 512))
        thumb = io.BytesIO()
        image.convert("RGB").save(thumb, "WEBP", quality=80)
    classification = result.get("classification")
    detections = result.get("detections")
    require(isinstance(detections, list) and len(detections) <= 500, "Invalid detections")
    for detection in detections:
        label(detection["label"])
        score(detection["score"])
        require(isinstance(detection.get("box"), list) and len(detection["box"]) == 4, "Invalid bounding box")
        for point in detection["box"]:
            score(point)
        x1, y1, x2, y2 = detection["box"]
        require(x1 < x2 and y1 < y2, "Invalid bounding box order")
    top = max(detections, key=lambda detection: detection["score"], default=None)
    primary = label(top["label"]) if top else "no detection"
    subtype = label(classification["label"]) if classification else None
    if subtype in ("person", "no detection", "unclassified", "vehicle"):
        primary = subtype
    if len(primary) > 20:
        primary = "animal"
    if subtype == primary:
        subtype = None
    confidence = score(classification["score"] if classification else top["score"] if top else 0)
    capture = photo.get("capturedAt")
    require(capture is None or isinstance(capture, str) and len(capture) <= 100, "Invalid capture time")
    # REVEAL's capture text has no offset. Do not reinterpret it as UTC or local server time.
    timestamp = photo.get("uploadedAt")
    time_basis = "reveal_upload"
    if timestamp is None:
        timestamp = result["processedAt"]
        time_basis = "label_processed_no_upload_time"
    require(isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool) and math.isfinite(timestamp)
            and 0 < timestamp < 100_000_000_000_000, "Invalid timestamp")
    start = timestamp / 1000
    event_id = "htp-" + hashlib.sha256((camera + ":" + photo_id).encode()).hexdigest()[:26]
    description = "REVEAL still photo. " + ("Possibly " if classification and classification.get("uncertain") else "")
    description += (subtype or primary) + ". Timeline uses " + ("REVEAL upload time" if time_basis == "reveal_upload" else "label processing time (upload time unavailable)")
    if capture:
        description += "; camera capture text: " + capture + " (timezone unknown)"
    data = {"type": "api", "score": confidence, "top_score": confidence, "description": description,
            "hometruth": {"owner": OWNER, "photo_id": photo_id, "image_hash": result["imageHash"],
                          "captured_at": capture, "time_basis": time_basis, "result": result}}
    if top:
        x1, y1, x2, y2 = top["box"]
        data["box"] = [x1, y1, x2 - x1, y2 - y1]
    return {"id": event_id, "photo_id": photo_id, "camera": camera, "label": primary, "sub_label": subtype,
            "start_time": start, "end_time": start, "score": confidence, "data": json.dumps(data, separators=(",", ":")),
            "jpeg": jpeg, "thumbnail": thumb.getvalue()}


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".hometruth-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def import_batch(payload, version, config, database=Path("/config/frigate.db"), clips=Path("/media/frigate/clips")):
    require(version == SUPPORTED_VERSION, "Frigate version changed; photo importer needs verification")
    photos = payload.get("photos")
    require(isinstance(photos, list) and 0 < len(photos) <= 20, "Invalid import batch")
    prepared = [prepare(photo, config) for photo in photos]
    require(len({p["id"] for p in prepared}) == len(prepared), "Duplicate photo in batch")
    require(database.is_file(), "Frigate database unavailable")
    db = sqlite3.connect(f"file:{database}?mode=rw", uri=True, timeout=15)
    try:
        columns = {row[1] for row in db.execute("PRAGMA table_info(event)")}
        require({"id", "camera", "label", "sub_label", "start_time", "end_time", "has_clip", "has_snapshot",
                 "retain_indefinitely", "thumbnail", "data", "zones", "false_positive"} <= columns, "Unsupported event schema")
        # Back up this live WAL database consistently once per verified importer version.
        backup = database.parent / "hometruth" / ("before-photo-import-" + SUPPORTED_VERSION + ".sqlite")
        if not backup.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            temporary = backup.with_suffix(".tmp")
            with sqlite3.connect(temporary) as destination:
                db.backup(destination)
            os.chmod(temporary, 0o600)
            os.replace(temporary, backup)
        # Check ownership before touching either files or metadata. Never overwrite a camera event.
        db.execute("BEGIN IMMEDIATE")
        for event in prepared:
            old = db.execute("SELECT camera, data FROM event WHERE id = ?", (event["id"],)).fetchone()
            if old:
                owned = json.loads(old[1]).get("hometruth", {})
                require(old[0] == event["camera"] and owned.get("owner") == OWNER and owned.get("photo_id") == event["photo_id"], "Event ID ownership conflict")
        for event in prepared:
            atomic_write(clips / f"{event['camera']}-{event['id']}.jpg", event["jpeg"])
            atomic_write(clips / "thumbs" / event["camera"] / f"{event['id']}.webp", event["thumbnail"])
            db.execute("""INSERT INTO event (id, camera, label, sub_label, start_time, end_time,
                score, top_score, false_positive, zones, thumbnail, has_clip, has_snapshot, retain_indefinitely, data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', NULL, 0, 1, 1, ?)
                ON CONFLICT(id) DO UPDATE SET label=excluded.label, sub_label=excluded.sub_label,
                score=excluded.score, top_score=excluded.top_score, data=excluded.data,
                has_clip=0, has_snapshot=1, retain_indefinitely=1""",
                (event["id"], event["camera"], event["label"], event["sub_label"], event["start_time"], event["end_time"],
                 event["score"], event["score"], event["data"]))
        db.commit()
        return {"imported": [event["photo_id"] for event in prepared]}
    finally:
        db.close()


def main():
    payload = sys.stdin.buffer.read(MAX_INPUT + 1)
    require(len(payload) <= MAX_INPUT, "Import request exceeds limit")
    with urllib.request.urlopen("http://127.0.0.1:5000/api/version", timeout=10) as response:
        version = response.read().decode().strip().strip('"')
    with urllib.request.urlopen("http://127.0.0.1:5000/api/config", timeout=10) as response:
        config = json.load(response)
    print(json.dumps(import_batch(json.loads(payload), version, config)))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No credentials, image contents, or inference payloads in process logs.
        print("Frigate photo import failed; HomeTruth will retry", file=sys.stderr)
        sys.exit(1)
