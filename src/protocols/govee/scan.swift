import Foundation
import CoreBluetooth

// Only observation: no pairing, connections, characteristic writes, or device changes.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

final class Scanner: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager!
    private var names: [UUID: String] = [:]

    override init() {
        super.init()
        manager = CBCentralManager(delegate: self, queue: .main)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state: String
        switch central.state {
        case .poweredOn:
            state = "scanning"
            central.scanForPeripherals(withServices: [CBUUID(string: "EC88")],
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        case .poweredOff: state = "poweredOff"
        case .unauthorized: state = "unauthorized"
        case .unsupported: state = "unsupported"
        case .resetting: state = "resetting"
        default: state = "unknown"
        }
        emit(["type": "status", "state": state])
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name,
           name.range(of: "^(GV|Govee_)H5075_[0-9A-Fa-f]{4}$", options: .regularExpression) != nil {
            names[peripheral.identifier] = name
        }
        guard let name = names[peripheral.identifier],
              let data = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data else { return }
        emit(["type": "advertisement", "peripheralId": peripheral.identifier.uuidString,
              "name": name, "manufacturerData": data.map { String(format: "%02x", $0) }.joined(),
              "rssi": RSSI.intValue])
    }
}

let scanner = Scanner()
// Parent exit (including a hot reload) must not leave an orphan scanning forever.
let parent = getppid()
let parentWatch = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
    if getppid() != parent { exit(0) }
}
if CommandLine.arguments.count > 1, let seconds = Double(CommandLine.arguments[1]), seconds > 0 {
    Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in exit(0) }
}
RunLoop.main.run()
