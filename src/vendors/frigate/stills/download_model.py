"""Download the official, versioned SpeciesNet release during image build only."""
import hashlib
import json
import shutil
from pathlib import Path

from speciesnet.utils import ModelInfo

SOURCE = "kaggle:google/speciesnet/pyTorch/v4.0.3a/1"
source = ModelInfo(SOURCE)
target = Path("/models/speciesnet")
target.mkdir(parents=True, exist_ok=True)
info = {"version": source.version, "type": source.type_}
hashes = {}
for key in ("classifier", "classifier_labels", "detector", "taxonomy", "geofence"):
    path = getattr(source, key)
    shutil.copyfile(path, target / path.name)
    info[key] = path.name
    hashes[key] = hashlib.file_digest(open(path, "rb"), "sha256").hexdigest()
(target / "info.json").write_text(json.dumps(info))
manifest = {"source": SOURCE, "files": hashes}
manifest["sha256"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
(target / "manifest.json").write_text(json.dumps(manifest))
