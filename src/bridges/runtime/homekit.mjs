import { Accessory, Bridge, Service, Characteristic, Categories, HAPStorage, HAPStatus, HapStatusError, uuid } from '@homebridge/hap-nodejs';
import { identity } from './worker.mjs';
import { cameraController } from './camera.mjs';

let configuredStorage;
export async function createBridge({ bridge, storage, accessories, profiles }, request) {
  if (configuredStorage && configuredStorage !== storage) throw new Error("Run each HomeKit bridge in its own process");
  if (!configuredStorage) { HAPStorage.setCustomStoragePath(storage); configuredStorage = storage; }
  const root = new Bridge(bridge.name, uuid.generate(`hometruth-bridge:${bridge.id}`));
  const identityFor = id => identity(storage, id);
  const rootIdentity = await identityFor(bridge.id);
  const network = process.env.HOMETRUTH_HOMEKIT_IPV4_ONLY === 'true' ? { bind: '0.0.0.0' } : {};
  const bindings = new Map(), external = [], closers = [];
  let closed = false;
  function configureInformation(accessory, id, name) {
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, 'HomeTruth')
      .setCharacteristic(Characteristic.Model, name).setCharacteristic(Characteristic.SerialNumber, id)
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');
  }
  configureInformation(root, bridge.id, 'Bridge');
  for (const item of accessories) {
    const profile = profiles.find(profile => profile.id === item.profile);
    if (!profile) throw new Error('Unsupported HomeKit profile');
    const accessory = new Accessory(item.name, uuid.generate(`${bridge.id}:${item.id}`));
    configureInformation(accessory, item.id, profile.name);
    const binding = { item, accessory, snapshot: { reachable: false, values: {} }, generation: 0, writing: 0, characteristics: new Map() };
    bindings.set(item.id, binding);
    if (item.profile === 'Camera' || item.profile === 'VideoDoorbell') {
      const camera = cameraController(item, request);
      accessory.configureController(camera.controller); closers.push(camera.close);
      if (item.profile === 'VideoDoorbell') binding.characteristics.set('ProgrammableSwitchEvent', accessory.getService(Service.Doorbell).getCharacteristic(Characteristic.ProgrammableSwitchEvent));
    } else {
      const Type = Service[profile.service];
      if (!Type) throw new Error('Unsupported HomeKit service');
      const service = accessory.addService(new Type(item.name, item.id));
      if (service.testCharacteristic(Characteristic.ConfiguredName)) service.setCharacteristic(Characteristic.ConfiguredName, item.name);
      if (item.profile === 'Television') for (const input of item.inputs ?? []) {
        const source = accessory.addService(new Service.InputSource(input.name, `input-${input.id}`));
        source.setCharacteristic(Characteristic.Identifier, input.id).setCharacteristic(Characteristic.ConfiguredName, input.name)
          .setCharacteristic(Characteristic.InputSourceType, 0).setCharacteristic(Characteristic.IsConfigured, 1);
        service.addLinkedService(source);
      }
      for (const definition of profile.characteristics) {
        const spec = item.characteristics[definition.key];
        if (!spec && definition.required) throw new Error(`Missing required ${definition.key}`);
        if (!spec) continue;
        const characteristic = service.getCharacteristic(Characteristic[definition.key]);
        const momentary = item.profile === 'MomentarySwitch' && definition.key === 'On';
        binding.characteristics.set(definition.key, characteristic);
        if (definition.format === 'uint8' && spec.commands && !spec.write) characteristic.setProps({ validValues: Object.keys(spec.commands).map(Number) });
        if (definition.readable && definition.key !== 'ProgrammableSwitchEvent') characteristic.onGet(async () => {
          const snapshot = await request('read', { accessory: item.id });
          if (!snapshot.reachable || snapshot.values[definition.key] === undefined) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          return momentary ? false : snapshot.values[definition.key];
        });
        if (definition.writable) characteristic.onSet(async value => {
          if (momentary && value === false) return;
          if (spec.constant !== undefined && value === spec.constant && !spec.write && !spec.commands) return;
          binding.generation++; binding.writing++;
          try {
            const snapshot = await request('write', { accessory: item.id, key: definition.key, value });
            update(binding, snapshot);
            // HAP writes the accepted input after awaiting onSet. Reset on the next
            // event-loop turn so that a successful trigger cannot remain latched on.
            if (momentary) setImmediate(() => { if (!closed) characteristic.sendEventNotification(false); });
          } catch {
            if (momentary) characteristic.updateValue(false);
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          }
          finally { binding.writing--; binding.generation++; }
        });
      }
    }
    if (profile.external) {
      const credentials = await identityFor(item.id);
      external.push({ item, accessory, credentials });
    } else root.addBridgedAccessory(accessory);
  }
  function update(binding, snapshot) {
    for (const [key, characteristic] of binding.characteristics) {
      // Event-only characteristics represent edges, never a replayed cached state.
      if (key === 'ProgrammableSwitchEvent') continue;
      if (!snapshot.reachable || snapshot.values[key] === undefined) characteristic.updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      else characteristic.updateValue(binding.item.profile === 'MomentarySwitch' && key === 'On' ? false : snapshot.values[key]);
    }
    binding.snapshot = snapshot;
  }
  await root.publish({ ...rootIdentity, ...network, port: bridge.port, category: Categories.BRIDGE });
  try {
    for (let i = 0; i < external.length; i++) {
      const entry = external[i];
      await entry.accessory.publish({ ...entry.credentials, ...network, port: bridge.port ? bridge.port + i + 1 : 0, category: profiles.find(p => p.id === entry.item.profile).category });
    }
  } catch (error) { await root.unpublish(); throw error; }
  return {
    accessories: new Map([...bindings].map(([id,b])=>[id,b.accessory])),
    async refresh() {
      const versions = new Map([...bindings].map(([id, binding]) => [id, binding.generation]));
      const snapshots = await request('snapshots');
      for (const snapshot of snapshots) {
        const binding = bindings.get(snapshot.id);
        if (binding && !binding.writing && versions.get(snapshot.id) === binding.generation) update(binding, snapshot);
      }
    },
    event(id, key, value) { bindings.get(id)?.characteristics.get(key)?.sendEventNotification(value); },
    status() {
      return { running: !closed, paired: Boolean(root._accessoryInfo?.paired()), updatedAt: new Date().toISOString(),
        detail: Boolean(root._accessoryInfo?.paired()) ? 'Paired with Apple Home' : 'Ready to pair', accessories: bindings.size,
        reachable: [...bindings.values()].filter(b => b.snapshot.reachable).length,
        ...(!Boolean(root._accessoryInfo?.paired()) ? { pairing: { code: rootIdentity.pincode, uri: root.setupURI() } } : {}),
        externalAccessories: external.map(({ item, accessory, credentials }) => ({ id: item.id, name: item.name, paired: Boolean(accessory._accessoryInfo?.paired()), ...(!Boolean(accessory._accessoryInfo?.paired()) ? { code: credentials.pincode, uri: accessory.setupURI() } : {}) })) };
    },
    async pair() { if (Boolean(root._accessoryInfo?.paired())) throw new Error('Use Apple Home to share a paired HomeKit bridge'); },
    async close() { closed = true; for (const close of closers) close(); await Promise.all([root, ...external.map(e => e.accessory)].map(a => a.unpublish())); },
  };
}
