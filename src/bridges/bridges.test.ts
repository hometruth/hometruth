import { afterEach, expect, test } from "bun:test";
import { BridgeStore } from "./store";
import { BridgeService } from "./service";
import { BridgeError, transform } from "./model";
import { at } from "./adapter";
import { createApp } from "../server/app";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { Device } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { elementKey } from "../tags/identity";
import { DeviceEventLogs } from "../models/device-event-log";
import { ACCESSORY_PROFILES, alternativeProfiles, validateMapping } from "./profiles";
import { addressesFor } from "../element-api/addresses";
const cleanup: (()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0))close();});
class Relay extends BinarySwitch {
  value:"on"|"off"="off"; offline=false; writes=0;
  async getState(){if(this.offline)throw new Error("Offline");return this.value;}
  async turnOn(){if(this.offline)throw new Error("Offline");this.writes++;this.value="on" as const;}
  async turnOff(){if(this.offline)throw new Error("Offline");this.writes++;this.value="off" as const;}
  async toggle(){this.value=this.value==="on"?"off":"on";}
}
class RelayDevice extends Device<{host:string}> {
  readonly model=SHELLY_PLUS_1;readonly capabilities;
  constructor(readonly relay:Relay){super("test-relay","Test relay",{host:"10.88.0.2"});this.capabilities={binarySwitch:relay};}
  async probe(){return {};}
}
function fixture(){const relay=new Relay("test-relay"),device=new RelayDevice(relay),site=new Site([device]),hub=new StateHub(),store=new BridgeStore(),service=new BridgeService(store),logs=new DeviceEventLogs();
 const app=createApp(undefined,site,undefined,undefined,undefined,undefined,logs,undefined,service,undefined,undefined,undefined,hub);cleanup.push(()=>hub.stop(),()=>store.close());
 const call=(path:string,method="GET",body?:unknown)=>app.request(path,{method,...(body?{headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});return {relay,device,site,hub,store,service,app,call,logs};}

test("bridges have independent identities, ports, membership and optimistic revisions",()=>{
 const store=new BridgeStore();cleanup.push(()=>store.close());const a=store.create("A","homekit"),b=store.create("B","homekit"),m=store.create("Matter","matter");
 expect(new Set([a.id,b.id,m.id]).size).toBe(3);expect(b.port-a.port).toBe(160);expect(a.members).toEqual([]);
 const key=elementKey("device","synthetic");store.update(a.id,{revision:1,members:[{element:key,mappings:[]}]});expect(store.get(b.id).members).toEqual([]);
 expect(()=>store.update(a.id,{revision:1,name:"stale"})).toThrow(BridgeError);expect(()=>store.remove(a.id,1)).toThrow(BridgeError);
 expect(()=>store.update(b.id,{revision:1,members:[{element:"not-an-element",mappings:[]}]})).toThrow();
 store.remove(a.id,2);expect(store.list().length).toBe(2);
});
test("native relay reports observed state and command failures, without acting during configuration",async()=>{
 const f=fixture();f.hub.observer.publish(f.device.id,await f.device.describe());const bridge=f.store.create("Home","matter"),element=elementKey("device",f.device.id);
 f.service.validate({...bridge,members:[{element,mappings:[]}]});expect(f.relay.writes).toBe(0);
 const exported=f.service.adapter.exports({...bridge,members:[{element,mappings:[]}]})[0]!;
 expect(f.service.adapter.snapshot(exported)).toMatchObject({reachable:true,values:{On:false}});
 await f.service.adapter.write(exported,"On",true);expect(f.relay.writes).toBe(1);expect(f.service.adapter.snapshot(exported).values.On).toBe(true);
 expect(f.logs.recent(f.device.id).some(e=>e.type==="apple_bridge_control" && e.data?.outcome==="succeeded")).toBe(true);
 f.relay.offline=true;await expect(f.service.adapter.write(exported,"On",false)).rejects.toThrow();expect(f.relay.writes).toBe(1);
 expect(f.logs.recent(f.device.id).some(e=>e.type==="apple_bridge_control" && e.data?.outcome==="failed")).toBe(true);
});
test("API supports many bridges per item and rejects missing state, unknown controls and stale writes",async()=>{
 const f=fixture();f.hub.observer.publish(f.device.id,await f.device.describe());const element=elementKey("device",f.device.id),address=addressesFor(f.hub).address(element)!;
 const created=await f.call('/api/bridges','POST',{name:'First',protocol:'homekit'});expect(created.status).toBe(201);const a=(await created.json() as any).bridge;
 const b=f.store.create('Second','matter');for(const id of [a.id,b.id])expect((await f.call(`/api/bridges/${id}/members/${address}`,'PUT',{revision:1,mappings:[]})).status).toBe(200);
 expect(f.store.get(a.id).members.length).toBe(1);expect(f.store.get(b.id).members.length).toBe(1);
 expect((await f.call(`/api/bridges/${a.id}`,'PUT',{revision:1,name:'Stale'})).status).toBe(409);
 expect((await f.call(`/api/bridges/${a.id}/members/${address}`,'PUT',{revision:2,mappings:[{id:'bad',name:'Lock',profile:'LockMechanism',characteristics:{}}]})).status).toBe(400);
 const options=await (await f.call(`/api/bridges/options/${address}`)).json() as any;expect(options.bridges.every((b:any)=>b.member!==null)).toBe(true);
 await f.call(`/api/bridges/${a.id}/members/${address}`,'DELETE',{revision:2});expect(f.store.get(a.id).members.length).toBe(0);expect(f.store.get(b.id).members.length).toBe(1);
 const html=await (await f.call('/bridges/'+a.id)).text();expect(html).toContain('data-mapping-editor');expect(html).toContain('Robot vacuum');expect(html).toContain('Video doorbell');expect(f.relay.writes).toBe(0);
});
test("automatic accessories take Apple Home names, compatible types and omissions without changing identity",async()=>{
 const f=fixture();f.hub.observer.publish(f.device.id,await f.device.describe());const element=elementKey("device",f.device.id),address=addressesFor(f.hub).address(element)!;
 const bridge=f.store.create('Home','homekit');
 const plain=f.service.adapter.exports({...bridge,members:[{element,mappings:[]}]})[0]!;
 expect(plain).toMatchObject({slot:'binarySwitch',name:'Test relay',profile:'Switch'});
 expect(alternativeProfiles(plain,'homekit')).toEqual(['Lightbulb','Outlet','Switch']);expect(alternativeProfiles(plain,'matter')).toEqual(['Outlet','Switch']);
 const response=await f.call(`/api/bridges/${bridge.id}/members/${address}`,'PUT',{revision:1,mappings:[],accessories:{binarySwitch:{name:'Fountain',profile:'Outlet'}}});
 expect(response.status).toBe(200);const body=await response.json() as any;
 expect(body.items).toEqual([{element,name:'Test relay',page:expect.any(String),missing:false,custom:false,accessories:[{slot:'binarySwitch',id:plain.id,name:'Fountain',automaticName:'Test relay',profile:'Outlet',automaticProfile:'Switch',profiles:['Lightbulb','Outlet','Switch'],hidden:false}]}]);
 const renamed=f.service.adapter.exports(f.store.get(bridge.id))[0]!;expect(renamed).toMatchObject({id:plain.id,name:'Fountain',profile:'Outlet'});
 expect(f.service.adapter.snapshot(renamed)).toMatchObject({reachable:true,values:{On:false}});
 const reject=async(accessories:unknown)=>(await f.call(`/api/bridges/${bridge.id}/members/${address}`,'PUT',{revision:2,mappings:[],accessories})).status;
 expect(await reject({binarySwitch:{profile:'LockMechanism'}})).toBe(400);
 expect(await reject({binarySwitch:{hidden:true}})).toBe(400);
 expect(await reject({binarySwitch:{name:'   '}})).toBe(400);
 expect(()=>f.store.update(bridge.id,{revision:2,members:[{element,mappings:[{id:'x',name:'X',profile:'Switch',characteristics:{}}],accessories:{binarySwitch:{name:'Y'}}}]})).toThrow(BridgeError);
 // A role the device no longer offers is inert rather than an outage.
 expect(f.service.adapter.exports({...bridge,members:[{element,mappings:[],accessories:{gone:{hidden:true}}}]})).toHaveLength(1);
 expect(f.relay.writes).toBe(0);
});
test("a member that no longer resolves is reported with its reason, and the bridge page renders it",async()=>{
 const f=fixture();f.hub.observer.publish(f.device.id,await f.device.describe());const bridge=f.store.create('Home','homekit');
 const items=f.service.adapter.shared({...bridge,members:[{element:elementKey("device","removed-device"),mappings:[]}]});
 expect(items).toEqual([expect.objectContaining({missing:true,problem:'An assigned element no longer exists',accessories:[]})]);
});
test("the status stream sends the current status and then only real changes",async()=>{
 const f=fixture();const bridge=f.store.create('Home','homekit');
 const response=await f.call(`/api/bridges/${bridge.id}/stream`);expect(response.headers.get('content-type')).toBe('text/event-stream');
 const reader=response.body!.getReader(),decoder=new TextDecoder();let text='';
 while(!text.includes('event: status')){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value);}
 expect(text).toContain('"running":false');await reader.cancel();
 const heard:unknown[]=[];const stop=f.service.watch(bridge.id,status=>heard.push(status));
 (f.service as any).notify(bridge.id);(f.service as any).notify(bridge.id);expect(heard).toHaveLength(1);
 f.store.update(bridge.id,{revision:1,enabled:false});(f.service as any).notify(bridge.id);expect(heard).toHaveLength(2);stop();
});
test("configurable mappings require real state and declared controls for every included characteristic",()=>{
 expect(ACCESSORY_PROFILES.length).toBe(40);
 expect(()=>validateMapping({id:'lock',name:'Lock',profile:'LockMechanism',characteristics:{LockCurrentState:{constant:1},LockTargetState:{constant:1}}},'homekit',()=>true)).toThrow('observed state');
 expect(()=>validateMapping({id:'switch',name:'Switch',profile:'Switch',characteristics:{On:{read:{element:'p',path:''},write:{element:'c'}},Name:{constant:'x'}}},'homekit',()=>true)).toThrow();
 expect(()=>validateMapping({id:'switch',name:'Switch',profile:'Switch',characteristics:{On:{read:{element:'p',path:''},write:{element:'missing'}}}},'homekit',(_k,control)=>!control)).toThrow('missing control');
});
test("mapping transformations are explicit and paths cannot access prototypes",()=>{
 expect(transform(212,{scale:5/9,offset:-160/9})).toBeCloseTo(100);expect(transform(2000,{conversion:'kelvin-mired'})).toBe(500);
 expect(transform('open',{values:{open:1,closed:0}})).toBe(1);expect(()=>transform(undefined,{})).toThrow();
 expect(transform('#ff0000',{conversion:'hex-hue'})).toBe(0);expect(transform('#ff0000',{conversion:'hex-saturation'})).toBe(100);
 expect(at({sensors:{'with/slash':3}},'/sensors/with~1slash')).toBe(3);expect(()=>at({},'/constructor')).toThrow();
});

test.skipIf(process.env.HOMETRUTH_BRIDGE_NETWORK_TEST !== "1")("snapshot protocol workers keep pairing identity and stop independently", async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const storage=await mkdtemp(join(tmpdir(),"ht-workers-test-"));
 const {runtimePaths}=await import("../runtime/paths"),{createSourceSnapshot}=await import("../runtime/snapshot");
 const {fileURLToPath}=await import("node:url");
 const snapshot=await createSourceSnapshot(runtimePaths(fileURLToPath(new URL("../../",import.meta.url)),storage),"bridges-test");
 const {BridgeService:SnapshotBridgeService}=await import(join(snapshot,"src/bridges/service.ts"));
 const f=fixture(),service:BridgeService=new SnapshotBridgeService(f.store,join(storage,"bridges"));service.configure(f.site,f.hub,f.logs);
 f.hub.observer.publish(f.device.id,await f.device.describe());const key=elementKey("device",f.device.id);
 const a=f.store.create('Synthetic HomeKit','homekit'),b=f.store.create('Synthetic Matter','matter');
 for(const bridge of [a,b])f.store.update(bridge.id,{revision:1,members:[{element:key,mappings:[]}]});
 const until=async(check:()=>boolean)=>{const deadline=Date.now()+15000;while(!check()){if(Date.now()>deadline)throw new Error('Worker did not reach expected state');await new Promise(resolve=>setTimeout(resolve,100));}};
 service.start();
 try {await until(()=>service.state(a.id).running&&service.state(b.id).running);expect(service.state(a.id).accessories).toBe(1);expect(service.state(b.id).accessories).toBe(1);
  const pairing=service.state(a.id).pairing;f.store.update(a.id,{revision:2,name:'Renamed synthetic bridge'});await until(()=>service.state(a.id).running&&service.events().filter(e=>e.message.startsWith('Renamed')).length>0);expect(service.state(a.id).pairing).toEqual(pairing);expect(service.state(b.id).running).toBe(true);
  f.store.update(a.id,{revision:3,enabled:false});await until(()=>!service.state(a.id).running);expect(service.state(b.id).running).toBe(true);expect(f.relay.writes).toBe(0);
 }finally{await service.stop();await rm(storage,{recursive:true,force:true});}
},35000);


test("bridge pages emit parseable scripts and declared API response shapes", async()=>{
 const {bridgeCatalogSchema}=await import("./schemas");const Ajv=(await import("ajv/dist/2020")).default;
 const f=fixture();const bridge=f.store.create("<Synthetic bridge>","homekit");
 const valid=new Ajv({strict:true,allowUnionTypes:true}).compile(bridgeCatalogSchema);
 const catalog=await (await f.call('/api/bridges/catalog')).json();expect(valid(catalog)).toBe(true);
 for(const page of ['/bridges','/bridges/'+bridge.id,'/switches/test-relay/settings']) {
  const html=await (await f.call(page)).text();
  for(const match of html.matchAll(/<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/g))expect(()=>new Function(match[1]!)).not.toThrow();
 }
});
