#!/usr/bin/env python3
"""Linux twin of scan.swift: the same JSON lines, read from BlueZ over D-Bus.

Only observation: no pairing, connections, characteristic writes, or device
changes. Needs bluetoothd, python3-dbus and python3-gi. The peripheral id is
the Bluetooth address BlueZ reports.
"""
import json
import os
import re
import sys

import dbus
import dbus.mainloop.glib
from gi.repository import GLib

NAME = re.compile(r"^(GV|Govee_)H5075_[0-9A-Fa-f]{4}$")
GOVEE = 0xEC88
BLUEZ = "org.bluez"
DEVICE = "org.bluez.Device1"
ADAPTER = "org.bluez.Adapter1"


def emit(value):
    try:
        sys.stdout.write(json.dumps(value, sort_keys=True) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:  # the reader is gone; so is the reason to scan
        os._exit(0)


dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
loop = GLib.MainLoop()
devices = {}  # object path -> merged Device1 properties


def objects():
    return dbus.Interface(bus.get_object(BLUEZ, "/"), "org.freedesktop.DBus.ObjectManager").GetManagedObjects()


def report(path):
    props = devices.get(path, {})
    name = str(props.get("Name", props.get("Alias", "")))
    data = props.get("ManufacturerData", {}).get(dbus.UInt16(GOVEE))
    if not NAME.match(name) or data is None or "Address" not in props:
        return
    # CoreBluetooth prefixes manufacturer data with the little-endian company id.
    payload = bytes([GOVEE & 0xFF, GOVEE >> 8]) + bytes(data)
    frame = {"type": "advertisement", "peripheralId": str(props["Address"]).upper(), "name": name, "manufacturerData": payload.hex()}
    if "RSSI" in props:
        frame["rssi"] = int(props["RSSI"])
    emit(frame)


def added(path, interfaces):
    if DEVICE in interfaces:
        devices[path] = dict(interfaces[DEVICE])
        report(path)


def changed(interface, values, _invalidated, path=None):
    if interface != DEVICE or path is None:
        return
    devices.setdefault(path, {}).update(values)
    if "ManufacturerData" in values:
        report(path)


def adapter():
    for path, interfaces in objects().items():
        if ADAPTER in interfaces:
            return path, interfaces[ADAPTER]
    return None, None


def start():
    path, props = adapter()
    if path is None:
        emit({"type": "status", "state": "unsupported"})
        return False
    if not props.get("Powered", False):
        emit({"type": "status", "state": "poweredOff"})
        return True
    control = dbus.Interface(bus.get_object(BLUEZ, path), ADAPTER)
    control.SetDiscoveryFilter({"Transport": "le", "DuplicateData": dbus.Boolean(True)})
    for device_path, interfaces in objects().items():
        if DEVICE in interfaces:
            devices[device_path] = dict(interfaces[DEVICE])
    try:
        control.StartDiscovery()
    except dbus.exceptions.DBusException as error:
        if "InProgress" not in error.get_dbus_name():
            raise
    emit({"type": "status", "state": "scanning"})
    return True


def adapter_changed(interface, values, _invalidated, path=None):
    if interface == ADAPTER and "Powered" in values:
        if values["Powered"]:
            start()
        else:
            emit({"type": "status", "state": "poweredOff"})


bus.add_signal_receiver(added, dbus_interface="org.freedesktop.DBus.ObjectManager", signal_name="InterfacesAdded")
bus.add_signal_receiver(changed, dbus_interface="org.freedesktop.DBus.Properties", signal_name="PropertiesChanged", path_keyword="path")
bus.add_signal_receiver(adapter_changed, dbus_interface="org.freedesktop.DBus.Properties", signal_name="PropertiesChanged", path_keyword="path")

try:
    if not start():
        sys.exit(1)
except dbus.exceptions.DBusException as error:
    emit({"type": "status", "state": "unauthorized" if "AccessDenied" in error.get_dbus_name() else "unknown"})
    sys.exit(1)

# Parent exit (including a hot reload) must not leave an orphan scanning forever.
parent = os.getppid()
GLib.timeout_add_seconds(2, lambda: os.getppid() == parent or loop.quit())
if len(sys.argv) > 1 and float(sys.argv[1]) > 0:
    GLib.timeout_add(int(float(sys.argv[1]) * 1000), loop.quit)
loop.run()
