# Govee H5075 thermometer and hygrometer

The `govee-h5075` model reads temperature (°C), relative humidity (%), and
battery (%) directly from Bluetooth advertisements. The current receiver uses a macOS host's Bluetooth adapter and needs no Govee account, Wi-Fi, pairing code, or cloud API key.
The device owns three separate `Sensor` instances: `TemperatureSensor`,
`HumiditySensor`, and `BatterySensor`. Each has its own schema, availability,
value, and observation timestamp. `/api/devices/:id` returns them in
`object.sensors`; `model.sensors` lists their identities and schema IDs.
The device itself satisfies `sensorDeviceSchema`, which composes the HomeTruth
object with an array of individually typed sensors and supports multiple sensors
of the same type. A sensor is identified by its device ID plus its local sensor ID.

The page lives at `/devices/<device-name>` and displays each sensor separately.
In TypeScript,
use `device.sensors`, `device.getSensors()`, or `device.temperature.getState()`
(and `humidity` / `battery`) to read the component sensors. These observations
have no write controls.

## Setup

This receiver currently supports macOS, with Bluetooth enabled and Xcode Command
Line Tools installed (`xcode-select --install` if needed). HomeTruth builds a small
Swift/CoreBluetooth helper into the ignored `.hometruth/bluetooth/` directory on
first use. It includes a Bluetooth usage description. Allow Bluetooth for the app
running HomeTruth under **System Settings → Privacy & Security → Bluetooth** if
macOS asks. The server host must remain awake and within Bluetooth range.

With the sensor nearby, discover its identity:

```sh
# From the private installation directory; adjust the source path if needed:
bun ../hometruth/src/vendors/govee/discover.ts 20
```

The result includes each H5075's `name`, `peripheralId`, current readings, and
observation time. Match its readings to the physical display. Multiple matching
thermometers must be distinguished before provisioning. Add the selected UUID
to `devices.yml`:

```yaml
  - id: govee-thermometer
    name: Govee thermometer
    model: govee-h5075
    config:
      peripheralId: "00000000-0000-0000-0000-000000000001" # use discovery's actual UUID
      bluetoothName: "GVH5075_ABCD" # optional display label
      staleAfterMs: 120000 # optional; default two minutes
```

macOS identifies a BLE peripheral by a UUID rather than exposing its MAC address.
Discover it again if moving HomeTruth to a different Mac. `peripheralId` is the
device selector; `bluetoothName` is a display label. Do not use the printed serial
number or put a Bluetooth address in the inventory's LAN `mac` field.

The running development server picks up code changes, and inventory saves reload
the site automatically. Verify after a broadcast arrives:

```sh
bun run ht govee-thermometer
```

## Availability and scope

One shared receiver listens for all configured H5075 devices. It starts on the
first state read, retries a failed helper on subsequent reads after 30 seconds,
and stops during server shutdown or hot reload. Changing the inventory does not
spawn additional receivers. Bluetooth adapter recovery resumes scanning.

Observation timestamps come from receipt of a broadcast, never a page refresh.
Readings older than `staleAfterMs` disappear and the sensor becomes offline;
new broadcasts restore it. An adapter failure clears cached observations. A
sensor fault suppresses temperature and humidity while retaining battery level.
Invalid and unrelated advertisements are ignored, including malformed payloads.
The receiver handles the concatenated Govee/iBeacon data observed on macOS.

This integration reads current broadcast measurements. It does not download
stored history or change calibration, alarms, or display units. The Govee Home
app remains available for those functions. Historical min/max figures shown on
the LCD are not exposed as current sensor readings.

References: [Govee H5075 specifications and Bluetooth FAQ](https://eu.govee.com/products/govee-bluetooth-hygrometer-thermometer-h5075),
[H5075 protocol observations](https://github.com/Heckie75/govee-h5075-thermo-hygrometer/blob/main/API.md),
[Govee BLE parser and error flag](https://github.com/Bluetooth-Devices/govee-ble/blob/main/src/govee_ble/parser.py).
