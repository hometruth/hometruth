#!/usr/bin/env python3
"""One bounded USB experiment, not a daemon. Python 3 POSIX stdlib only.

Owns its disk log so a HomeTruth worker reload does not discard received data.
Never transmits through the nRF24 or changes the computer/router Wi-Fi.
"""
import base64
import fcntl
import json
import os
import select
import stat
import sys
import termios
import time
import tty
from datetime import datetime, timezone

PROFILES = ("esb-1000", "esb-250", "esb-2000", "xn297-1000", "xn297-250", "xn297-2000")


def utc():
    return datetime.now(timezone.utc).isoformat()


def write_all(fd, data):
    while data:
        count = os.write(fd, data)
        if count <= 0:
            raise OSError("Short USB/disk write")
        data = data[count:]


class Recorder:
    def __init__(self, config):
        self.config = config
        self.status = dict(config["status"])
        self.fd = os.open(self.status["path"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        directory = os.open(os.path.dirname(self.status["path"]), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def append(self, event):
        row = dict(event, recordedAt=utc(), captureId=self.status["captureId"],
                   deviceId=self.config["deviceId"])
        write_all(self.fd, (json.dumps(row, separators=(",", ":")) + "\n").encode())
        os.fsync(self.fd)
        self.status["records"] = self.status.get("records", 0) + 1

    def update(self, **fields):
        self.status.update(fields, updatedAt=utc())
        temporary = self.config["statusPath"] + ".tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            write_all(fd, json.dumps(self.status).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, self.config["statusPath"])
        directory = os.open(os.path.dirname(temporary), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def capture(config, recorder):
    profile = recorder.status["profile"]
    profile_index = PROFILES.index(profile)  # Reject before opening USB.
    channel = recorder.status["channel"]
    duration_ms = recorder.status["durationMs"]
    if (type(duration_ms) is not int or duration_ms not in (10000, 20000)
            or not (channel is None or (type(channel) is int and 5 <= channel <= 75))):
        raise RuntimeError("Invalid bounded capture channel/duration")
    # POSIX raw serial without pyserial or DTR/RTS reset toggles. flock covers
    # sibling HomeTruth workers; TIOCEXCL rejects other serial openers.
    fd = os.open(config["port"], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    old = None
    try:
        if not stat.S_ISCHR(os.fstat(fd).st_mode):
            raise RuntimeError("USB path is not a character device")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.ioctl(fd, termios.TIOCEXCL)
        old = termios.tcgetattr(fd)
        tty.setraw(fd, termios.TCSANOW)
        attributes = termios.tcgetattr(fd)
        attributes[4] = attributes[5] = termios.B115200
        attributes[2] |= termios.CLOCAL | termios.CREAD
        attributes[2] &= ~termios.HUPCL
        termios.tcsetattr(fd, termios.TCSANOW, attributes)
        token = recorder.status["captureId"]
        recorder.append({"event": "usb_open", "port": config["port"],
                         "note": config["note"], "wifiOff": recorder.status["wifiOff"], "profile": profile,
                         "channel": channel, "durationMs": duration_ms})
        write_all(fd, ("TMNT HELLO " + token + "\n").encode())
        buffer = b""
        deadline = time.monotonic() + 6
        sent = ended = snapshot = False
        connected = False
        raw_frames = 0
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], 0.2)[0]:
                continue
            chunk = os.read(fd, 4096)
            if not chunk:
                raise RuntimeError("USB disconnected; capture may be incomplete")
            buffer += chunk
            if len(buffer) > 65536:
                recorder.append({"event": "oversize_usb_data", "base64": base64.b64encode(buffer).decode()})
                raise RuntimeError("USB record exceeded 64 KiB")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                # Persist bytes before interpretation, including malformed data.
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    recorder.append({"event": "usb_bytes", "base64": base64.b64encode(line).decode()})
                    # CH340 can deliver buffered boot bytes from before baud
                    # setup immediately before our first reply. Preserve those
                    # bytes, and accept only a nonce-checked ready object suffix.
                    marker = line.find(b'{"type"')
                    if sent or marker < 0:
                        continue
                    try:
                        value = json.loads(line[marker:])
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(value, dict) or value.get("type") != "usb_ready":
                        continue
                recorder.append({"event": "usb_record", "body": value})
                if not isinstance(value, dict):
                    continue
                kind = value.get("type")
                if kind == "usb_ready" and value.get("nonce") == token and not sent:
                    if (value.get("deviceId") != config["deviceId"] or value.get("protocol") != 3
                            or value.get("radioPresent") is not True or value.get("active") is not False):
                        raise RuntimeError("USB identity/readiness/protocol mismatch; firmware 0.7.0 (USB protocol 3) required. No capture started")
                    recorder.append({"event": "usb_capture_intent", "durationMs": duration_ms, "channel": channel,
                                     "wifiOff": recorder.status["wifiOff"], "note": config["note"], "profile": profile})
                    if config.get("sessionPlan"):
                        recorder.append({"event": "usb_session_plan", "plan": config["sessionPlan"],
                                         "physicalActionsVerified": False})
                    recorder.update(phase="starting")
                    # Exactly once; never retry this command on an uncertain reply.
                    write_all(fd, ("TMNT CAPTURE " + token + " " + str(int(recorder.status["wifiOff"]))
                                   + " " + str(profile_index) + " " + str(-1 if channel is None else channel)
                                   + " " + str(duration_ms) + "\n").encode())
                    sent = True
                    deadline = time.monotonic() + duration_ms / 1000 + 30
                elif kind == "usb_error":
                    raise RuntimeError("Firmware refused capture: " + str(value.get("error")))
                elif kind == "usb_capture_start" and value.get("captureId") == token:
                    if (value.get("profile") != profile or "channel" not in value
                            or value.get("channel") != channel or value.get("durationMs") != duration_ms):
                        raise RuntimeError("Firmware capture settings mismatch; retained data is not the requested test")
                    recorder.update(phase="capturing", captureStartedAt=utc(), elapsedMs=0)
                elif kind == "usb_raw" and value.get("captureId") == token:
                    if channel is not None and value.get("channel") != channel:
                        raise RuntimeError("Unexpected channel in parked capture; retained data is not the requested test")
                    if value.get("frame") != raw_frames + 1:
                        raise RuntimeError("Gap in raw USB frame numbers; saved data is incomplete")
                    raw_frames += 1
                elif kind in ("usb_progress", "usb_capture_end") and value.get("captureId") == token:
                    ended = kind == "usb_capture_end"
                    if ended:
                        if value.get("rawFramesSeen") != raw_frames:
                            raise RuntimeError("Raw USB count mismatch; saved data is incomplete")
                        connected = value.get("wifiConnected") is True
                    recorder.update(phase="reconnecting" if ended else "capturing",
                                    elapsedMs=value.get("elapsedMs"), packets=value.get("packets"),
                                    rawFramesSeen=value.get("rawFramesSeen"), energy=value.get("energy"))
                elif kind == "usb_snapshot" and value.get("captureId") == token:
                    snapshot = True
                    recorder.update(snapshot=value.get("state"))
                elif kind == "network_status" and value.get("connected") is True and ended:
                    connected = True
                if ended and snapshot and connected:
                    recorder.append({"event": "usb_capture_complete", "networkRestored": True})
                    recorder.update(phase="complete", networkRestored=True)
                    return
        if buffer:
            recorder.append({"event": "usb_partial_tail", "base64": base64.b64encode(buffer).decode()})
        if ended and snapshot:
            recorder.update(phase="recorded", networkRestored=False,
                            error="Capture saved; Wi-Fi reconnection was not confirmed. Check bridge power/network.")
        else:
            raise RuntimeError(("USB capture" if sent else "USB handshake") + " timed out; data saved so far is retained. No automatic retry.")
    finally:
        if old is not None:
            # Keep HUPCL clear: closing the recorder must not reset the board.
            old[2] &= ~termios.HUPCL
            termios.tcsetattr(fd, termios.TCSANOW, old)
        os.close(fd)


def main():
    config = json.loads(sys.stdin.readline())
    recorder = Recorder(config)
    try:
        capture(config, recorder)
    except Exception as error:
        recorder.append({"event": "usb_capture_error", "error": str(error)})
        recorder.update(phase="failed", error=str(error))
        return 1
    finally:
        os.close(recorder.fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
