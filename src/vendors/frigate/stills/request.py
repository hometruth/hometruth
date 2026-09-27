"""SSH/docker-exec transport: JPEG on stdin, bounded JSON response on stdout."""
import sys
import urllib.request

MAX_BYTES = 20 * 1024 * 1024
image = sys.stdin.buffer.read(MAX_BYTES + 1)
if not image or len(image) > MAX_BYTES:
    raise SystemExit("Invalid image size")
request = urllib.request.Request("http://127.0.0.1:8080/label", image, {"Content-Type": "image/jpeg"})
with urllib.request.urlopen(request, timeout=180) as response:
    output = response.read(65537)
    if len(output) > 65536:
        raise SystemExit("Label response exceeds limit")
    sys.stdout.buffer.write(output)
