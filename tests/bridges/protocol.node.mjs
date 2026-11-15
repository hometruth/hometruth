import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service, Characteristic } from '@homebridge/hap-nodejs';
import { createBridge as homekit } from '../../src/bridges/runtime/homekit.mjs';
import { createBridge as matter } from '../../src/bridges/runtime/matter.mjs';
import { OnOffServer } from '@matter/main/behaviors/on-off';
import { RvcCleanModeServer } from '@matter/main/behaviors/rvc-clean-mode';
import { RvcRunModeServer } from '@matter/main/behaviors/rvc-run-mode';
import { RvcOperationalStateServer } from '@matter/main/behaviors/rvc-operational-state';
// Use the effective catalog passed by BridgeService, including application profiles.
const profiles = JSON.parse(execFileSync('bun', ['-e', `import { ACCESSORY_PROFILES } from ${JSON.stringify(new URL('../../src/bridges/profiles.ts',import.meta.url).href)}; process.stdout.write(JSON.stringify(ACCESSORY_PROFILES));`], { encoding: 'utf8' }));
const base = {id:'10000000-0000-4000-8000-000000000001',name:'Synthetic bridge',port:0,revision:1,enabled:true,members:[]};
const value = c => c.format==='bool'?false:c.values?.[0]??c.minimum??(['float','int','uint8','uint16','uint32','uint64'].includes(c.format)?0:'');
const fixture = protocol => {
 const accessories=profiles.filter(p=>p.protocols.includes(protocol)).map(p=>({id:'test-'+p.id,name:p.id==='MomentarySwitch'?'Synthetic button':p.name,profile:p.id,element:'synthetic',...(p.id==='Camera'||p.id==='VideoDoorbell'?{cameraDevice:'synthetic-camera'}:{}),characteristics:Object.fromEntries(p.characteristics.filter(c=>c.required).map(c=>[c.key,p.id==='MomentarySwitch'&&c.key==='On'?{trigger:{element:'synthetic-button'}}:{read:{element:'synthetic',path:''},...(c.writable?{write:{element:'synthetic'}}:{})}]))}));
 const snapshots = new Map(accessories.map(a=>[a.id,{id:a.id,reachable:true,values:Object.fromEntries(profiles.find(p=>p.id===a.profile).characteristics.filter(c=>c.required).map(c=>[c.key,value(c)]))}]));
 const writes=[],presses=[];let fail=false;
 const request=async (operation,data) => {
  if(operation==='snapshots')return structuredClone([...snapshots.values()]);
  const current=snapshots.get(data.accessory);
  if(operation==='read')return structuredClone(current);
  if(operation==='write'){
   if(fail)throw new Error('Synthetic offline device');writes.push(data);
   if(data.accessory==='test-MomentarySwitch'){if(data.value===true)presses.push(data.accessory);current.values.On=false;}
   else current.values[data.key]=data.value;
   return structuredClone(current);
  }
  throw new Error('No real media or hardware in this test');
 };
 return {accessories,snapshots,request,writes,presses,fail:()=>{fail=true;}};
};

test('HomeKit constructs every declared profile and routes reads, writes, events and unreachable state', async()=>{
 const storage=await mkdtemp(join(tmpdir(),'ht-hap-test-'));const f=fixture('homekit');let runtime;
 const previousIpv4Only=process.env.HOMETRUTH_HOMEKIT_IPV4_ONLY;
 delete process.env.HOMETRUTH_HOMEKIT_IPV4_ONLY;
 const assertNetwork=ipv4Only=>{
  const root=runtime.accessories.get('test-Switch').getPrimaryAccessory();
  const television=runtime.accessories.get('test-Television');
  for(const accessory of [root,television])assert.equal(accessory._advertiser.advertisedService.disableIpv6===true,ipv4Only);
 };
 try {
  runtime=await homekit({bridge:{...base,protocol:'homekit'},storage,accessories:f.accessories,profiles},f.request);
  assertNetwork(false);
  await runtime.refresh();assert.equal(runtime.status().accessories,f.accessories.length);assert.ok(runtime.status().pairing.uri.startsWith('X-HM://'));
  const characteristic=runtime.accessories.get('test-Switch').getService(Service.Switch).getCharacteristic(Characteristic.On);
  assert.equal(await characteristic.handleGetRequest(),false);
  await characteristic.handleSetRequest(true);assert.equal(f.writes.at(-1).value,true);assert.equal(await characteristic.handleGetRequest(),true);
  const trigger=runtime.accessories.get('test-MomentarySwitch').getService(Service.Switch).getCharacteristic(Characteristic.On);
  const triggerEvents=[];trigger.on('change',event=>triggerEvents.push({value:event.newValue,reason:event.reason}));
  assert.equal(await trigger.handleGetRequest(),false);
  for(let press=1;press<=2;press++){
   triggerEvents.length=0;
   await trigger.handleSetRequest(true);
   assert.equal(f.presses.length,press);
   assert.equal(triggerEvents.at(-1).reason,'write');assert.equal(triggerEvents.at(-1).value,true);
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(trigger.value,false);
   assert.deepEqual(triggerEvents.at(-1),{value:false,reason:'event'});
   assert.equal(await trigger.handleGetRequest(),false);
  }
  await trigger.handleSetRequest(true);await trigger.handleSetRequest(true);
  assert.equal(f.presses.length,4);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(trigger.value,false);
  const writesBeforeOff=f.writes.length;
  await trigger.handleSetRequest(false);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.writes.length,writesBeforeOff);assert.equal(f.presses.length,4);assert.equal(trigger.value,false);
  f.snapshots.get('test-Switch').reachable=false;await runtime.refresh();await assert.rejects(characteristic.handleGetRequest());
  f.fail();await assert.rejects(characteristic.handleSetRequest(false));
  await assert.rejects(trigger.handleSetRequest(true));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(trigger.value,false);assert.equal(f.presses.length,4);
  const button=runtime.accessories.get('test-StatelessProgrammableSwitch').getService(Service.StatelessProgrammableSwitch).getCharacteristic(Characteristic.ProgrammableSwitchEvent);
  let events=0;button.on('change',()=>events++);runtime.event('test-StatelessProgrammableSwitch','ProgrammableSwitchEvent',0);runtime.event('test-StatelessProgrammableSwitch','ProgrammableSwitchEvent',0);assert.equal(events,2);
  const codes=runtime.status().pairing;await runtime.close();runtime=await homekit({bridge:{...base,protocol:'homekit'},storage,accessories:f.accessories,profiles},f.request);assert.deepEqual(runtime.status().pairing,codes);
  for(const setting of ['false','1','TRUE','true']){
   await runtime.close();process.env.HOMETRUTH_HOMEKIT_IPV4_ONLY=setting;
   runtime=await homekit({bridge:{...base,protocol:'homekit'},storage,accessories:f.accessories.filter(a=>['Switch','Television'].includes(a.profile)),profiles},f.request);
   assertNetwork(setting==='true');assert.deepEqual(runtime.status().pairing,codes);
  }
 }finally{
  if(previousIpv4Only===undefined)delete process.env.HOMETRUTH_HOMEKIT_IPV4_ONLY;else process.env.HOMETRUTH_HOMEKIT_IPV4_ONLY=previousIpv4Only;
  await runtime?.close();await rm(storage,{recursive:true,force:true});
 }
});

test('Matter constructs every declared profile and routes switch and robot vacuum commands', async()=>{
 const storage=await mkdtemp(join(tmpdir(),'ht-matter-test-'));const f=fixture('matter');let runtime;
 f.accessories.find(a=>a.profile==='RobotVacuum').characteristics.CleanMode={read:{element:'synthetic',path:''},write:{element:'synthetic'}};f.snapshots.get('test-RobotVacuum').values.CleanMode=0;
 try{
  runtime=await matter({bridge:{...base,protocol:'matter'},storage,accessories:f.accessories},f.request,{start:false});
  await runtime.refresh();assert.equal(runtime.status().accessories,f.accessories.length);
  const endpoint=id=>runtime.server.parts.get('accessories').parts.get(id);
  await endpoint('test-Switch').act(agent=>agent.get(OnOffServer).on());assert.equal(f.writes.at(-1).value,true);
  await endpoint('test-Switch').act(agent=>agent.get(OnOffServer).toggle());assert.equal(f.writes.at(-1).value,false);
  const vacuum=endpoint('test-RobotVacuum');await vacuum.act(async agent=>{assert.equal((await agent.get(RvcRunModeServer).changeToMode({newMode:1})).status,0);});assert.equal(f.writes.at(-1).key,'RunMode');
  await vacuum.act(async agent=>{assert.equal((await agent.get(RvcOperationalStateServer).goHome()).commandResponseState.errorStateId,0);});assert.equal(f.writes.at(-1).value,2);
  await vacuum.act(async agent=>{assert.equal((await agent.get(RvcCleanModeServer).changeToMode({newMode:2})).status,0);});assert.equal(f.writes.at(-1).key,'CleanMode');
  f.snapshots.get('test-Switch').reachable=false;await runtime.refresh();assert.equal(endpoint('test-Switch').state.bridgedDeviceBasicInformation.reachable,false);
  f.fail();await assert.rejects(endpoint('test-Switch').act(agent=>agent.get(OnOffServer).on()));
  const pairing=runtime.status().pairing;await runtime.close();runtime=await matter({bridge:{...base,protocol:'matter'},storage,accessories:f.accessories},f.request,{start:false});assert.deepEqual(runtime.status().pairing,pairing);
 }finally{await runtime?.close();await rm(storage,{recursive:true,force:true});}
});
