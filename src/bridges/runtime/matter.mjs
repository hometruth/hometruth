import { Endpoint, Environment, ServerNode, VendorId, CommissioningServer } from '@matter/main';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import { OnOffPlugInUnitDevice, OnOffPlugInUnitRequirements } from '@matter/main/devices/on-off-plug-in-unit';
import { TemperatureSensorDevice } from '@matter/main/devices/temperature-sensor';
import { HumiditySensorDevice } from '@matter/main/devices/humidity-sensor';
import { ContactSensorDevice } from '@matter/main/devices/contact-sensor';
import { OccupancySensorDevice } from '@matter/main/devices/occupancy-sensor';
import { OccupancySensingServer } from '@matter/main/behaviors/occupancy-sensing';
import { LightSensorDevice } from '@matter/main/devices/light-sensor';
import { RoboticVacuumCleanerDevice, RoboticVacuumCleanerRequirements as Rvc } from '@matter/main/devices/robotic-vacuum-cleaner';
import { RvcRunMode } from '@matter/main/clusters/rvc-run-mode';
import { RvcCleanMode } from '@matter/main/clusters/rvc-clean-mode';

const label = name => { let result = ''; for (const char of name) { if (Buffer.byteLength(result + char) > 32) break; result += char; } return result; };
const sensors = {
  TemperatureSensor: [TemperatureSensorDevice, 'temperatureMeasurement', 'measuredValue', 'CurrentTemperature', value => Math.round(value * 100)],
  HumiditySensor: [HumiditySensorDevice, 'relativeHumidityMeasurement', 'measuredValue', 'CurrentRelativeHumidity', value => Math.round(value * 100)],
  ContactSensor: [ContactSensorDevice, 'booleanState', 'stateValue', 'ContactSensorState', value => value === 0],
  OccupancySensor: [OccupancySensorDevice.with(OccupancySensingServer.with('Other')), 'occupancySensing', 'occupancy', 'OccupancyDetected', value => ({occupied: value === 1})],
  MotionSensor: [OccupancySensorDevice.with(OccupancySensingServer.with('Other')), 'occupancySensing', 'occupancy', 'MotionDetected', value => ({occupied: value === true})],
  LightSensor: [LightSensorDevice, 'illuminanceMeasurement', 'measuredValue', 'CurrentAmbientLightLevel', value => value <= 0 ? 0 : Math.max(0, Math.min(65534, Math.round(10000 * Math.log10(value) + 1)))],
};
export async function createBridge({ bridge, storage, accessories }, request, options = {}) {
  const environment = options.environment ?? Environment.default;
  environment.vars.set('storage.path', storage); environment.vars.set('log.level', 'error');
  const server = await ServerNode.create({ id: bridge.id, environment, network: {port: bridge.port},
    productDescription: {name: bridge.name, deviceType: AggregatorEndpoint.deviceType},
    basicInformation: {vendorName:'HomeTruth',vendorId:VendorId(0xfff1),productId:0x8001,productName:'HomeTruth bridge',productLabel:label(bridge.name),nodeLabel:label(bridge.name),serialNumber:bridge.id.replaceAll("-", "").slice(0, 32),hardwareVersion:1,hardwareVersionString:'1',softwareVersion:1,softwareVersionString:'1.0.0'} });
  const aggregator = await server.add(new Endpoint(AggregatorEndpoint, {id:'accessories'}));
  const bindings = new Map(); let closed = false;
  try {
    for (const item of accessories) {
      const binding = { item, snapshot: {reachable:false,values:{}}, writing:0, version:0 };
      const command = async (key,value) => {
        binding.writing++; binding.version++;
        try {
          const result = await request('write',{accessory:item.id,key,value});
          if (!result.reachable) throw new Error('The device did not report an observed state');
          binding.snapshot = result; return result.values;
        } finally { binding.writing--; binding.version++; }
      };
      let type, state = {}, update;
      if (item.profile === 'Switch' || item.profile === 'Outlet') {
        class OnOff extends OnOffPlugInUnitRequirements.OnOffServer {
          async on() { const values = await command('On',true); this.state.onOff = values.On; }
          async off() { const values = await command('On',false); this.state.onOff = values.On; }
          async toggle() { const current = await request('read',{accessory:item.id}); if (!current.reachable) throw new Error('Unavailable'); return current.values.On ? this.off() : this.on(); }
        }
        type = OnOffPlugInUnitDevice.with(OnOff); state = {onOff:{onOff:false}};
        update = values => ({onOff:{onOff:values.On}});
      } else if (sensors[item.profile]) {
        const [device,cluster,attribute,key,convert] = sensors[item.profile]; type = device;
        const initial = attribute === 'occupancy' ? {occupied:false} : attribute === 'stateValue' ? false : null;
        state = {[cluster]:{[attribute]:initial}};
        if (cluster === 'occupancySensing') state[cluster].occupancySensorType = 0;
        update = values => ({[cluster]:{[attribute]:convert(values[key])}});
      } else if (item.profile === 'RobotVacuum') {
        class Run extends Rvc.RvcRunModeServer {
          async changeToMode({newMode}) { if (![0,1].includes(newMode)) return {status:1}; try { this.state.currentMode = (await command('RunMode',newMode)).RunMode; return {status:0}; } catch { return {status:3}; } }
        }
        class Operation extends Rvc.RvcOperationalStateServer {
          async execute(value) { try { const observed = await command('Command',value); this.state.operationalState = observed.OperationalState; this.state.operationalError = {errorStateId:observed.OperationalError}; return {commandResponseState:{errorStateId:0}}; } catch { return {commandResponseState:{errorStateId:3}}; } }
          async pause() { return this.execute(0); } async resume() { return this.execute(1); } async goHome() { return this.execute(2); }
        }
        type = RoboticVacuumCleanerDevice.with(Run,Operation);
        state = {
          rvcRunMode:{supportedModes:[{label:'Idle',mode:0,modeTags:[{value:RvcRunMode.ModeTag.Idle}]},{label:'Cleaning',mode:1,modeTags:[{value:RvcRunMode.ModeTag.Cleaning}]}],currentMode:0},
          rvcOperationalState:{phaseList:null,currentPhase:null,operationalStateList:[0,1,2,3,64,65,66].map(operationalStateId=>({operationalStateId})),operationalState:0,operationalError:{errorStateId:0}},
        };
        if (item.characteristics.CleanMode) {
          class Clean extends Rvc.RvcCleanModeServer { async changeToMode({newMode}) { if (![0,1,2].includes(newMode)) return {status:1}; try { this.state.currentMode=(await command('CleanMode',newMode)).CleanMode; return {status:0}; } catch { return {status:3}; } } }
          type = type.with(Clean);
          state.rvcCleanMode = {supportedModes:[{label:'Vacuum',mode:0,modeTags:[{value:RvcCleanMode.ModeTag.Vacuum}]},{label:'Mop',mode:1,modeTags:[{value:RvcCleanMode.ModeTag.Mop}]},{label:'Vacuum and mop',mode:2,modeTags:[{value:RvcCleanMode.ModeTag.Vacuum},{value:RvcCleanMode.ModeTag.Mop}]}],currentMode:0};
        }
        update = values => ({rvcRunMode:{currentMode:values.RunMode},rvcOperationalState:{operationalState:values.OperationalState,operationalError:{errorStateId:values.OperationalError}},...(item.characteristics.CleanMode ? {rvcCleanMode:{currentMode:values.CleanMode}} : {})});
      } else throw new Error('This accessory type requires HomeKit');
      binding.endpoint = await aggregator.add(new Endpoint(type.with(BridgedDeviceBasicInformationServer), {
        id:item.id, ...state, bridgedDeviceBasicInformation:{nodeLabel:label(item.name),productName:label(item.profile),productLabel:label(item.name),serialNumber:item.id,uniqueId:item.id,reachable:false},
      }));
      binding.update = update; bindings.set(item.id,binding);
    }
    if (options.start !== false) await server.start();
  } catch (error) { await server.close(); throw error; }
  return {
    server,
    async refresh() {
      const versions = new Map([...bindings].map(([id,b])=>[id,b.version]));
      const snapshots = await request('snapshots');
      for (const snapshot of snapshots) {
        const binding = bindings.get(snapshot.id);
        if (!binding || binding.writing || versions.get(snapshot.id) !== binding.version) continue;
        await binding.endpoint.act(async agent => {
          // Serialize refresh and controller commands in the endpoint transaction.
          await agent.context.transaction.begin();
          if (binding.writing || versions.get(snapshot.id) !== binding.version) return;
          const state = snapshot.reachable ? binding.update(snapshot.values) : {};
          for (const [cluster, values] of Object.entries({...state,bridgedDeviceBasicInformation:{reachable:snapshot.reachable}})) { const behavior = binding.endpoint.behaviors.supported[cluster]; if (!behavior) throw new Error(`Missing ${cluster} on ${binding.item.profile}: ${Object.keys(binding.endpoint.behaviors.supported).join(",")}`); Object.assign(agent.get(behavior).state, values); }
          binding.snapshot = snapshot;
        });
      }
    },
    status() { const paired = server.lifecycle.isCommissioned, codes = server.state.commissioning.pairingCodes;
      return {running:!closed,paired,updatedAt:new Date().toISOString(),detail:paired?'Paired with Apple Home':'Ready to pair',accessories:bindings.size,reachable:[...bindings.values()].filter(b=>b.snapshot.reachable).length,
        ...(!paired?{pairing:{code:codes.manualPairingCode,uri:codes.qrPairingCode}}:{})}; },
    async pair() { if (server.lifecycle.isCommissioned) throw new Error('Use Apple Home to share a paired bridge'); await server.act(agent=>agent.get(CommissioningServer).enterCommissionableMode()); },
    async close() { closed=true; await server.close(); },
  };
}
