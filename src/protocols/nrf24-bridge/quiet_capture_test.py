"""PTY integration tests: no network servers or real radios."""
import json
import os
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path


class UsbCaptureTest(unittest.TestCase):
    def experiment(self, mismatch=False, unplug=False, protocol=3, gap=False, profile="xn297-250",
                   channel=40, duration_ms=20000, settings_mismatch=False, wrong_channel=False, session=False):
        with tempfile.TemporaryDirectory() as directory:
            master, slave = pty.openpty()
            token = str(uuid.uuid4())
            path = str(Path(directory) / "capture.jsonl")
            status_path = str(Path(directory) / "capture.status.json")
            config = {"deviceId": "tmnt-TEST", "port": os.ttyname(slave), "note": "car off; released",
                      "statusPath": status_path,
                      "status": {"captureId": token, "wifiOff": True, "profile": profile, "path": path,
                                 "channel": channel, "durationMs": duration_ms, "phase": "preparing"}}
            if session:
                config["sessionPlan"] = {"id": "tmnt-six-buttons", "durationMs": 20000,
                                         "steps": [{"startMs": 0, "endMs": 5000, "action": "off"}]}
                config["status"]["session"] = "tmnt-six-buttons"
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("quiet_capture.py"))],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                process.stdin.write((json.dumps(config) + "\n").encode())
                process.stdin.flush()
                def read_command():
                    data = b""
                    end = time.monotonic() + 3
                    while b"\n" not in data and time.monotonic() < end:
                        if select.select([master], [], [], 0.1)[0]:
                            data += os.read(master, 4096)
                    return data.decode().strip()
                def send(value):
                    os.write(master, (json.dumps(value) + "\n").encode())
                self.assertEqual(read_command(), "TMNT HELLO " + token)
                os.write(master, b"\x80\xf8boot-prefix")
                send({"type": "usb_ready", "protocol": protocol, "nonce": token,
                      "deviceId": "wrong" if mismatch else "tmnt-TEST", "radioPresent": True, "active": False})
                if mismatch or protocol != 3:
                    self.assertEqual(process.wait(timeout=3), 1)
                else:
                    profile_index = ("esb-1000", "esb-250", "esb-2000", "xn297-1000", "xn297-250", "xn297-2000").index(profile)
                    self.assertEqual(read_command(), "TMNT CAPTURE " + token + " 1 " + str(profile_index)
                                     + " " + str(-1 if channel is None else channel) + " " + str(duration_ms))
                    # Intent must already be on disk before the command is sent.
                    self.assertIn("usb_capture_intent", Path(path).read_text())
                    if session:
                        # Plan is durable BEFORE the capture command, not reconstructed afterward.
                        self.assertIn("usb_session_plan", Path(path).read_text())
                    send({"type": "usb_capture_start", "captureId": token, "profile": profile,
                          "channel": channel, "durationMs": 7 if settings_mismatch else duration_ms})
                    send({"type": "usb_raw", "captureId": token, "frame": 1,
                          "channel": 6 if wrong_channel else (5 if channel is None else channel),
                          "rxPipe": 0, "rawWindowHex": "BC" * 32})
                    send({"type": "usb_observation", "captureId": token,
                          "observation": {"sequence": 7, "rawWindowHex": "AB" * 32}})
                    os.write(master, b"not-json\n")
                    if settings_mismatch or wrong_channel:
                        self.assertEqual(process.wait(timeout=3), 1)
                    elif gap:
                        send({"type": "usb_raw", "captureId": token, "frame": 3})
                        self.assertEqual(process.wait(timeout=3), 1)
                    elif unplug:
                        os.close(master)
                        master = None
                        self.assertEqual(process.wait(timeout=3), 1)
                    else:
                        send({"type": "usb_capture_end", "captureId": token, "elapsedMs": duration_ms,
                              "packets": 1, "rawFramesSeen": 1, "energy": [[0, 1]] * 71, "wifiConnected": False})
                        send({"type": "usb_snapshot", "captureId": token, "state": {"sequence": 7}})
                        send({"type": "network_status", "connected": True})
                        self.assertEqual(process.wait(timeout=3), 0)
                status = json.loads(Path(status_path).read_text())
                rows = [json.loads(line) for line in Path(path).read_text().splitlines()]
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
                if mismatch or unplug or gap or protocol != 3 or settings_mismatch or wrong_channel:
                    self.assertEqual(status["phase"], "failed")
                    if mismatch or protocol != 3:
                        self.assertNotIn("usb_capture_intent", [row["event"] for row in rows])
                else:
                    self.assertEqual(status["phase"], "complete")
                    self.assertTrue(status["networkRestored"])
                    self.assertEqual(status["channel"], channel)
                    self.assertEqual(status["durationMs"], duration_ms)
                    if session:
                        self.assertEqual(status["session"], "tmnt-six-buttons")
                        plan = next(row for row in rows if row["event"] == "usb_session_plan")
                        self.assertEqual(plan["plan"], config["sessionPlan"])
                        self.assertFalse(plan["physicalActionsVerified"])
                    intent = next(row for row in rows if row["event"] == "usb_capture_intent")
                    self.assertEqual(intent["channel"], channel)
                    self.assertEqual(intent["durationMs"], duration_ms)
                    self.assertTrue(any(row["event"] == "usb_bytes" for row in rows))
                    self.assertEqual(status["snapshot"]["sequence"], 7)
                    self.assertEqual(sum(row.get("body", {}).get("type") == "usb_raw" for row in rows), 1)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate()
                if master is not None:
                    os.close(master)
                os.close(slave)

    def test_live_disk_and_reconnection(self):
        for profile in ("esb-1000", "esb-250", "esb-2000", "xn297-1000", "xn297-250", "xn297-2000"):
            with self.subTest(profile=profile):
                self.experiment(profile=profile)

    def test_old_protocol_never_starts(self):
        for protocol in (1, 2):
            self.experiment(protocol=protocol)

    def test_channel_duration_matrix(self):
        for channel in (None, 5, 40, 75):
            for duration_ms in (10000, 20000):
                with self.subTest(channel=channel, duration_ms=duration_ms):
                    self.experiment(channel=channel, duration_ms=duration_ms)

    def test_full_session_plan_is_durable(self):
        self.experiment(duration_ms=20000, profile="esb-1000", session=True)

    def test_changed_settings_fail(self):
        self.experiment(settings_mismatch=True)
        self.experiment(wrong_channel=True)

    def test_raw_gap_is_incomplete(self):
        self.experiment(gap=True)

    def test_wrong_identity_never_starts(self):
        self.experiment(mismatch=True)

    def test_usb_outage_retains_log(self):
        self.experiment(unplug=True)


if __name__ == "__main__":
    unittest.main()
