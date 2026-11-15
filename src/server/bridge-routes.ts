import { Hono } from "hono";
import { BridgeService } from "../bridges/service";
import { BridgeError, type BridgeDefinition, type BridgeMembership, type BridgeProtocol, type BridgeStatus } from "../bridges/model";
import { assertMembers } from "../bridges/store";
import { ACCESSORY_PROFILES } from "../bridges/profiles";
import { elementKey } from "../tags/identity";
import { pageCatalog } from "./page-catalog";
import { renderBridgesPage, renderBridgePage } from "../ui/bridges-page";
import { errorJson, pageContext, requestJson, type AppEnvironment } from "./http";
import QRCode from "qrcode";

export function bridgeRoutes(service: BridgeService) {
  const app = new Hono<AppEnvironment>();
  const catalog = () => {
    const elements = pageCatalog(service.adapter.hub).elements.filter(element => service.adapter.eligible(element.key));
    const controls = elements.filter(e => service.adapter.exists(e.key, true)).map(e => ({ key: e.key, name: `${e.context} · ${e.name}` }));
    for (const element of elements.filter(e => ["group", "group-switch", "speaker-group", "automation", "service"].includes(e.kind))) {
      const native = service.adapter.native(element.key);
      for (const accessory of native) for (const characteristic of Object.values(accessory.characteristics)) {
        for (const control of [...(characteristic.write ? [characteristic.write] : []), ...Object.values(characteristic.commands ?? {})]) {
          if (!controls.some(c => c.key === control.element)) controls.push({ key: control.element, name: `${element.name} · ${Buffer.from(control.element, "base64url").toString().split('"').at(-2)}` });
        }
      }
    }
    return { cameras: elements.filter(e => e.kind === "capability" && service.adapter.node(e.key)?.ids[1] === "camera").map(e => ({key:e.key,name:e.context})),
      buttons: elements.filter(e => e.kind === "capability" && service.adapter.node(e.key)?.ids[1] === "button").map(e => ({key:e.key,name:e.context})), profiles: ACCESSORY_PROFILES, elements: elements.map(e => ({ key:e.key, name:e.name, context:e.context, page:e.sourcePage || e.page, kind:e.kind })), controls,
      sources: elements.filter(e => service.adapter.exists(e.key, false)).map(e => ({key:e.key,name:`${e.context ? e.context + " · " : ""}${e.name}`, path:e.kind === "sensor" ? "/value" : ""})) };
  };
  /** Items that can be added with automatic settings first; everything else needs a custom mapping. */
  const SHAREABLE = new Set(["device", "group", "group-switch", "speaker-group", "automation", "service", "capability", "sensor"]);
  const candidates = (protocol: BridgeProtocol) => pageCatalog(service.adapter.hub).elements
    .filter(element => SHAREABLE.has(element.kind) && service.adapter.eligible(element.key))
    .map(element => {
      const parsed = service.adapter.node(element.key)?.ids, device = parsed ? service.adapter.site.get(parsed[0]!) : undefined;
      const room = service.adapter.site.roomOf(element.key, device?.room);
      // A capability of a device that is already shared would appear in Apple Home twice.
      const within = element.kind === "capability" || element.kind === "sensor" ? { device: elementKey("device", parsed![0]!) } : {};
      return { key: element.key, name: element.name, context: element.context, kind: element.kind, page: element.sourcePage || element.page,
        ...(room ? { room } : {}), ...within, automatic: service.adapter.automatic(element.key, protocol).map(accessory => accessory.profile) };
    });
  const items = (bridge: BridgeDefinition) => {
    const pages = pageCatalog(service.adapter.hub).byKey;
    return service.adapter.shared(bridge).map(item => {
      const element = pages.get(item.element);
      return element ? { ...item, page: element.sourcePage || element.page } : item;
    });
  };
  const view = (bridge: BridgeDefinition) => ({ bridge, items: items(bridge) });
  const options = (key: string) => ({ eligible: service.adapter.eligible(key), bridges: service.store.list().map(bridge => ({
    id:bridge.id,name:bridge.name,protocol:bridge.protocol,revision:bridge.revision,enabled:bridge.enabled,
    member:bridge.members.find(m => m.element === key) ?? null,
    automatic:service.adapter.automatic(key,bridge.protocol).map(a => ({name:a.name,profile:a.profile})),
  })) });
  const updateMembers = (id: string, revision: number, members: BridgeMembership[]): BridgeDefinition => {
    assertMembers(members);
    const current = service.store.get(id);
    if (revision !== current.revision) throw new BridgeError("This bridge changed. Refresh before saving.", "conflict");
    service.validate({...current,members});
    return service.store.update(id,{revision,members});
  };
  app.onError((error,c) => error instanceof BridgeError ? errorJson(c, error.code === "missing" ? 404 : error.code === "conflict" ? 409 : error.code === "unavailable" ? 503 : 400, error.code, error.message) : errorJson(c,500,"bridge_error","The bridge operation could not be completed"));
  app.get("/bridges", c => c.html(renderBridgesPage(pageContext(c),service.store.list().map(b => ({...b,status:service.state(b.id)})))));
  app.get("/bridges/:id", c => {
    const bridge=service.store.get(c.req.param("id"));
    c.header("Cache-Control","no-store");
    return c.html(renderBridgePage(pageContext(c),{...view(bridge),status:service.state(bridge.id),candidates:candidates(bridge.protocol),catalog:catalog()}));
  });
  app.get("/api/bridges", c => { c.header("Cache-Control","no-store"); return c.json({bridges:service.store.list().map(b => ({...b,status:service.state(b.id)}))}); });
  app.get("/api/bridges/catalog", c => c.json(catalog()));
  app.get("/api/bridges/options/:key", c => c.json(options(c.req.param("key"))));
  app.post("/api/bridges", async c => {
    const input = await requestJson(c) as Record<string,unknown>;
    if (!input || Object.keys(input).some(k => !["name","protocol"].includes(k)) || typeof input.name !== "string" || !["homekit","matter"].includes(String(input.protocol))) throw new BridgeError("Enter a name and choose HomeKit or Matter");
    const bridge=service.store.create(input.name,input.protocol as "homekit"|"matter"); return c.json({bridge,page:`/bridges/${bridge.id}`},201);
  });
  app.get("/api/bridges/:id", c => { const bridge=service.store.get(c.req.param("id")); c.header("Cache-Control","no-store"); return c.json({...view(bridge),status:service.state(bridge.id)}); });
  app.get("/api/bridges/:id/stream", c => {
    const id=service.store.get(c.req.param("id")).id;
    const encoder=new TextEncoder();
    let detach: (() => void) | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => { detach?.(); clearInterval(heartbeat); c.req.raw.signal.removeEventListener("abort", stop); };
    const stream=new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (status: BridgeStatus) => { try { controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`)); } catch { stop(); } };
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        send(service.state(id));
        detach=service.watch(id,send);
        heartbeat=setInterval(() => { try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { stop(); } },15000).unref();
        c.req.raw.signal.addEventListener("abort",stop,{once:true});
      }, cancel: stop,
    });
    return new Response(stream,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store","X-Accel-Buffering":"no"}});
  });
  app.put("/api/bridges/:id", async c => {
    const input=await requestJson(c) as Record<string,unknown>;
    if (!input || Object.keys(input).some(k=>!["revision","name","enabled","members"].includes(k)) || !Number.isInteger(input.revision)) throw new BridgeError("Invalid bridge settings");
    const current=service.store.get(c.req.param("id"));
    if (input.members !== undefined) { assertMembers(input.members); service.validate({...current,members:input.members as BridgeMembership[]}); }
    const bridge=service.store.update(current.id,input as Parameters<typeof service.store.update>[1]); return c.json(view(bridge));
  });
  app.put("/api/bridges/:id/members/:key", async c => {
    const input=await requestJson(c) as {revision:number;mappings:BridgeMembership["mappings"];accessories?:BridgeMembership["accessories"]};
    if (!input || Object.keys(input).some(k=>!["revision","mappings","accessories"].includes(k))) throw new BridgeError("Invalid membership");
    const key=c.req.param("key"),bridge=service.store.get(c.req.param("id"));
    const member: BridgeMembership={element:key,mappings:input.mappings,...(input.accessories!==undefined?{accessories:input.accessories}:{})};
    // Replacing in place keeps the item where it was in the bridge's list.
    const members=bridge.members.some(m=>m.element===key)?bridge.members.map(m=>m.element===key?member:m):[...bridge.members,member];
    return c.json(view(updateMembers(bridge.id,input.revision,members)));
  });
  app.delete("/api/bridges/:id/members/:key", async c => {
    const input=await requestJson(c) as {revision:number}; const bridge=service.store.get(c.req.param("id"));
    // Removing a broken mapping must still work when another assigned element is offline or deleted.
    return c.json(view(service.store.update(bridge.id,{revision:input?.revision,members:bridge.members.filter(m=>m.element!==c.req.param("key"))})));
  });
  app.delete("/api/bridges/:id", async c => { const input=await requestJson(c) as {revision:number}; service.store.remove(c.req.param("id"),input?.revision); return c.json({removed:true}); });
  app.post("/api/bridges/:id/pair", c => { service.pair(c.req.param("id")); return c.json({ok:true}); });
  app.get("/api/bridges/:id/qr", async c => {
    const status=service.state(c.req.param("id")),external=c.req.query("accessory");
    const uri=external ? status.externalAccessories?.find(a=>a.id===external)?.uri : status.pairing?.uri;
    if (!uri || !status.running) throw new BridgeError("No pairing code is currently available","missing");
    c.header("Cache-Control","no-store"); c.header("Content-Type","image/svg+xml");
    return c.body(await QRCode.toString(uri,{type:"svg",margin:4,errorCorrectionLevel:"M"}));
  });
  return app;
}
