/** Generate protocol metadata from the pinned library, without publishing accessories. Run with Node. */
import { Service, Characteristic, Categories } from '@homebridge/hap-nodejs';
import { writeFileSync } from 'node:fs';

const types = {
  AirPurifier: ['Air purifier', 19], AirQualitySensor: ['Air quality sensor', 10],
  Battery: ['Battery', 10], CarbonDioxideSensor: ['Carbon dioxide sensor', 10],
  CarbonMonoxideSensor: ['Carbon monoxide sensor', 10], ContactSensor: ['Contact sensor', 10],
  Door: ['Door', 12], Doorbell: ['Doorbell', 18], Fanv2: ['Fan', 3],
  Faucet: ['Faucet / shower', 29], FilterMaintenance: ['Filter', 10],
  GarageDoorOpener: ['Garage door opener', 4], HeaterCooler: ['Heater / air conditioner', 21],
  HumidifierDehumidifier: ['Humidifier / dehumidifier', 22], HumiditySensor: ['Humidity sensor', 10],
  IrrigationSystem: ['Irrigation system', 28], LeakSensor: ['Leak sensor', 10],
  Lightbulb: ['Light', 5], LightSensor: ['Light sensor', 10], LockMechanism: ['Lock', 6],
  MotionSensor: ['Motion sensor', 10], OccupancySensor: ['Occupancy sensor', 10],
  Outlet: ['Outlet', 7], SecuritySystem: ['Security system', 11], Slats: ['Slats', 14],
  SmokeSensor: ['Smoke alarm', 10], Speaker: ['Speaker volume', 26], SmartSpeaker: ['Speaker playback', 26],
  StatelessProgrammableSwitch: ['Programmable button', 15], Switch: ['Switch', 8],
  Television: ['Television / receiver', 31], TemperatureSensor: ['Temperature sensor', 10],
  Thermostat: ['Thermostat', 9], Valve: ['Valve / sprinkler', 29],
  Window: ['Window', 13], WindowCovering: ['Blind / shade', 14],
};
const matter = new Set(['Switch', 'Outlet', 'TemperatureSensor', 'HumiditySensor', 'ContactSensor', 'OccupancySensor', 'MotionSensor', 'LightSensor']);
const configuration = new Set(['TemperatureDisplayUnits','LockPhysicalControls','ValveType','ServiceLabelIndex',
  'ConfiguredName','Name','SleepDiscoveryMode','Identifier','IsConfigured','InputSourceType','InputDeviceType','ActiveIdentifier','SlatType']);
const chars = Object.entries(Characteristic).filter(([, v]) => typeof v === 'function' && v.UUID);
const ignored = new Set(['Name','ConfiguredName']);
const profiles = Object.entries(types).map(([id,[name,category]]) => {
  const service = new Service[id](name);
  const required = new Set(service.characteristics.map(c => c.UUID));
  return { id, name, service: id, category, protocols: matter.has(id) ? ['homekit','matter'] : ['homekit'],
    ...(id === 'Television' ? {external:true} : {}),
    characteristics: [...service.characteristics,...service.optionalCharacteristics].flatMap(c => {
      const key = chars.find(([, type]) => type.UUID === c.UUID)?.[0];
      if (!key || ignored.has(key)) return [];
      const p = c.props;
      return [{key, name:c.displayName, format:p.format, readable:p.perms.includes('pr'), writable:p.perms.includes('pw'),
        event:p.perms.includes('ev'), required:required.has(c.UUID), ...(p.unit ? {unit:p.unit}:{}),
        ...(p.minValue !== undefined ? {minimum:p.minValue}:{}), ...(p.maxValue !== undefined ? {maximum:p.maxValue}:{}),
        ...(p.minStep !== undefined ? {step:p.minStep}:{}), ...(p.validValues ? {values:p.validValues}:{}),
        ...(configuration.has(key) ? {configuration:true}:{})}];
    })};
});
profiles.push({id:'Camera',name:'Camera',service:'Camera',category:Categories.IP_CAMERA,protocols:['homekit'],characteristics:[]});
profiles.push({...profiles.find(p=>p.id==='Doorbell'),id:'VideoDoorbell',name:'Video doorbell',service:'VideoDoorbell'});
profiles.push({id:'RobotVacuum',name:'Robot vacuum / mop',service:'RobotVacuum',category:1,protocols:['matter'],characteristics:[
 {key:'RunMode',name:'Run mode (0 idle, 1 cleaning)',format:'uint8',readable:true,writable:true,event:true,required:true,values:[0,1]},
 {key:'OperationalState',name:'State (0 stopped, 1 running, 2 paused, 3 error, 64 returning, 65 charging, 66 docked)',format:'uint8',readable:true,writable:false,event:true,required:true,values:[0,1,2,3,64,65,66]},
 {key:'OperationalError',name:'Error code (0 no error)',format:'uint8',readable:true,writable:false,event:true,required:true,minimum:0,maximum:255},
 {key:'Command',name:'Command (0 pause, 1 resume, 2 return to dock)',format:'uint8',readable:false,writable:true,event:false,required:true,values:[0,1,2]},
 {key:'CleanMode',name:'Cleaning mode (0 vacuum, 1 mop, 2 vacuum and mop)',format:'uint8',readable:true,writable:true,event:true,required:false,values:[0,1,2]}
]});
writeFileSync(new URL('../../src/bridges/homekit-catalog.json',import.meta.url), JSON.stringify(profiles,null,2)+'\n');
console.log(`Generated ${profiles.length} Apple Home profiles`);
