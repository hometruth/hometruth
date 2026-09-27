"""Still-image inference beside Frigate. Runtime container has no network access.

This intentionally does not create Frigate video events or use its live-camera
tracker: each original JPEG receives its own durable HomeTruth result.
"""
import hashlib
import io
import json
import logging
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import torch
from PIL import Image
from speciesnet import SpeciesNet

torch.set_num_threads(2)
torch.set_num_interop_threads(1)
Image.MAX_IMAGE_PIXELS = 40_000_000
MODEL_PATH = "/models/speciesnet"
manifest = json.loads(Path(MODEL_PATH, "manifest.json").read_text())
model = SpeciesNet(MODEL_PATH, geofence=False)


def label_image(data):
    # Verify before inference; preserve original bytes and orientation for SpeciesNet.
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "JPEG" or image.width * image.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError("Unsupported image")
        image.verify()
    with tempfile.TemporaryDirectory(prefix="hometruth-photo-") as directory:
        path = Path(directory, "photo.jpg")
        path.write_bytes(data)
        response = model.predict(filepaths=[str(path)], run_mode="single_thread", progress_bars=False)
    prediction = response["predictions"][0]
    if prediction.get("failures") or "prediction" not in prediction:
        raise RuntimeError("Inference did not complete")
    taxonomy = prediction["prediction"]
    name = taxonomy.split(";")[-1].strip() or "unknown"
    score = float(prediction["prediction_score"])
    detections = []
    for detection in prediction.get("detections", []):
        if detection["conf"] < 0.5:
            continue
        x, y, width, height = detection["bbox"]
        box = [max(0, min(1, v)) for v in (x, y, x + width, y + height)]
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        detections.append({"label": detection["label"], "score": detection["conf"], "box": box})
    classes = prediction.get("classifications", {})
    candidates = [{"label": tax.split(";")[-1].strip() or "unknown", "score": float(confidence)}
                  for tax, confidence in zip(classes.get("classes", []), classes.get("scores", []))]
    return {
        "engine": "SpeciesNet on Frigate host", "model": "SpeciesNet " + prediction["model_version"],
        "modelHash": manifest["sha256"], "processedAt": int(time.time() * 1000),
        "imageHash": hashlib.sha256(data).hexdigest(), "detections": detections,
        "classification": {"label": name, "score": score, "taxonomy": taxonomy,
                           "uncertain": score < 0.8 or name in ("unknown", "animal"), "candidates": candidates},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != "/label":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 20 * 1024 * 1024:
                raise ValueError("Invalid image size")
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("Incomplete image")
            result = label_image(data)
            body = json.dumps(result, allow_nan=False).encode()
            self.send_response(200)
        except Exception:
            logging.exception("Still-image inference failed")
            body = b'{"error":"Still-image inference failed"}'
            self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("HomeTruth still-image labeler ready", flush=True)
    HTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
