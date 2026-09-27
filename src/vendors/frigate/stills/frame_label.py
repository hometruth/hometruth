"""One JPEG in, dog or no dog out, using an OpenVINO object model on the Frigate host.

Length-prefixed JPEGs arrive on stdin; JSON lines leave on stdout. The process
exits on EOF, idle timeout or error. It has no listener and saves no images.
"""
from functools import lru_cache
import signal
import struct
import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import openvino as ov

MODEL = Path('/config/hometruth/yolov9-s-640.onnx')
LABELS = Path('/labelmap/coco-80.txt')
MAX_BYTES = 8 * 1024 * 1024


def regions(width, height):
    # Overlapping crops make smaller subjects occupy more of the detector input.
    yield 0, 0, width, height
    crop_w, crop_h = round(width * .65), round(height * .65)
    for x in (0, width - crop_w):
        for y in (0, height - crop_h):
            yield x, y, x + crop_w, y + crop_h



@lru_cache(maxsize=1)
def detector():
    names = {int(line.split(maxsplit=1)[0]): line.split(maxsplit=1)[1] for line in LABELS.read_text().splitlines()}
    if names.get(16) != "dog":
        raise ValueError("Unexpected dog label")
    cache = Path('/config/model_cache/hometruth-frames')
    cache.mkdir(parents=True, exist_ok=True)
    core = ov.Core()
    core.set_property({'CACHE_DIR': str(cache)})
    model = core.compile_model(str(MODEL), 'NPU')
    if list(model.input(0).shape) != [1, 3, 640, 640] or list(model.output(0).shape) != [1, 84, 8400]:
        raise ValueError('Unexpected object model shape')
    return model


def label_image(data):
    if not data or len(data) > MAX_BYTES or not data.startswith(b'\xff\xd8'):
        raise ValueError('Invalid JPEG')
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape[0] * image.shape[1] > 40_000_000:
        raise ValueError('Invalid image')
    height, width = image.shape[:2]
    model = detector()
    image_hash = hashlib.sha256(data).hexdigest()
    for x, y, right, bottom in regions(width, height):
        crop = image[y:bottom, x:right]
        scale = 640 / max(crop.shape[:2])
        resized = cv2.resize(crop, (round(crop.shape[1] * scale), round(crop.shape[0] * scale)))
        pad_x, pad_y = (640 - resized.shape[1]) // 2, (640 - resized.shape[0]) // 2
        padded = np.full((640, 640, 3), 114, dtype=np.uint8)
        padded[pad_y:pad_y + resized.shape[0], pad_x:pad_x + resized.shape[1]] = resized
        tensor = np.expand_dims(cv2.cvtColor(padded, cv2.COLOR_BGR2RGB).transpose(2, 0, 1), axis=0).astype(np.float32) / 255
        rows = model(tensor)[model.output(0)][0].T
        # The COCO dog class is 16. Stop at the first confident dog; no counting,
        # box merging, breed recognition or labels for unrelated objects.
        classes = rows[:, 4:].argmax(axis=1)
        if np.any((classes == 16) & (rows[:, 20] >= .7)
                  & np.isfinite(rows).all(axis=1) & (rows[:, 2] > 0) & (rows[:, 3] > 0)):
            return {'dog': True, 'imageHash': image_hash}
    return {'dog': False, 'imageHash': image_hash}


def read_exact(length):
    data = bytearray()
    while len(data) < length:
        chunk = sys.stdin.buffer.read(length - len(data))
        if not chunk:
            raise EOFError()
        data.extend(chunk)
    return bytes(data)


def expired(*_):
    raise TimeoutError()


if __name__ == '__main__':
    signal.signal(signal.SIGALRM, expired)
    try:
        while True:
            signal.alarm(15)
            length = struct.unpack('!I', read_exact(4))[0]
            if not 0 < length <= MAX_BYTES:
                raise ValueError('Invalid frame size')
            signal.alarm(5)
            data = read_exact(length)
            print(json.dumps(label_image(data), allow_nan=False), flush=True)
    except (EOFError, TimeoutError):
        pass
    except Exception:
        print('Frame labeling failed', file=sys.stderr)
        sys.exit(1)
