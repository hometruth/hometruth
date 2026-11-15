const value = { type: ["string", "number", "boolean", "null"] };
const transform = {
  scale: { type: "number", not: { const: 0 } }, offset: { type: "number" },
  values: { type: "object", maxProperties: 256, additionalProperties: value },
  conversion: { enum: ["kelvin-mired", "hex-hue", "hex-saturation", "battery-low", "co2-high", "pm25-quality"] },
};
const element = { type: "string", minLength: 1, maxLength: 4096 };
const accessoryName = { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" };
const accessoryOverrides = { type: "object", minProperties: 1, maxProperties: 64, propertyNames: { type: "string", minLength: 1, maxLength: 200 }, additionalProperties: {
  type: "object", additionalProperties: false, minProperties: 1, properties: {
    name: accessoryName, profile: { type: "string", minLength: 1, maxLength: 100 }, hidden: { const: true },
  },
} };
const control = { type: "object", additionalProperties: false, required: ["element"], properties: { element, value, ...transform } };
export const bridgeMembershipsSchema = {
  type: "array", maxItems: 500, items: {
    type: "object", additionalProperties: false, required: ["element", "mappings"], properties: {
      element, accessories: accessoryOverrides, mappings: { type: "array", maxItems: 32, items: {
        type: "object", additionalProperties: false, required: ["id", "name", "profile", "characteristics"], properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" }, name: accessoryName,
          profile: { type: "string", minLength: 1, maxLength: 100 }, camera: element,
          characteristics: { type: "object", maxProperties: 100, additionalProperties: {
            type: "object", additionalProperties: false, properties: {
              constant: value,
              event: { type: "object", additionalProperties: false, required: ["element"], properties: { element } },
              trigger: { type: "object", additionalProperties: false, required: ["element"], properties: { element } },
              read: { type: "object", additionalProperties: false, required: ["element", "path"], properties: {
                element, path: { type: "string", maxLength: 500 }, ...transform,
              } },
              write: control, commands: { type: "object", maxProperties: 256, additionalProperties: control },
            }, minProperties: 1,
            anyOf: [{ properties: { trigger: {} }, required: ["trigger"], maxProperties: 1 }, { not: { properties: { trigger: {} }, required: ["trigger"] } }],
          } },
        },
      } },
    },
  },
};

const text = {type:"string"};
const flag = {type:"boolean"};
const number = {type:"integer",minimum:0};
const revision = {type:"integer",minimum:1};
const protocol = {enum:["homekit","matter"]};
const object = (title:string,properties:Record<string,unknown>,required=Object.keys(properties)) => ({title,type:"object",additionalProperties:false,properties,required});
const list = (items:unknown) => ({type:"array",items});
const name = {type:"string",minLength:1,maxLength:100};
export const bridgeDefinitionSchema = object("Apple Home bridge", {id:text,name,protocol,enabled:flag,port:{type:"integer",minimum:1,maximum:65535},revision,members:bridgeMembershipsSchema});
export const bridgeStatusSchema = object("Bridge connection", {running:flag,paired:flag,updatedAt:text,detail:text,accessories:number,reachable:number,
  pairing:object("Initial pairing credentials",{code:text,uri:text}),
  externalAccessories:list(object("Separately paired accessory",{id:text,name:text,paired:flag,code:text,uri:text},["id","name","paired"])),
  fault:text,unreachable:list(text)},["running","paired","updatedAt","detail","accessories","reachable"]);
export const sharedItemSchema = object("Shared item",{element:text,name:text,room:text,page:text,missing:flag,problem:text,custom:flag,
  accessories:list(object("Shared accessory",{slot:text,id:text,name:text,automaticName:text,profile:text,automaticProfile:text,profiles:list(text),hidden:flag}))},["element","name","missing","custom","accessories"]);
export const bridgeUpdateSchema = object("Update bridge",{revision,name,enabled:flag,members:bridgeMembershipsSchema},["revision"]);
export const bridgeCreateSchema = object("Create bridge",{name,protocol});
const bridgeResponse=object("Bridge and shared items",{bridge:bridgeDefinitionSchema,items:list(sharedItemSchema)});
const revisionRequest=object("Current bridge revision",{revision});
const characteristic=object("Apple characteristic",{key:text,name:text,format:text,readable:flag,writable:flag,event:flag,required:flag,unit:text,minimum:{type:"number"},maximum:{type:"number"},step:{type:"number"},values:list({type:"number"}),configuration:flag},["key","name","format","readable","writable","event","required"]);
const profile=object("Apple accessory type",{id:text,name:text,protocols:list(protocol),service:text,category:number,external:flag,characteristics:list(characteristic)},["id","name","protocols","service","category","characteristics"]);
export const bridgeCatalogSchema=object("Mapping catalog",{profiles:list(profile),
  elements:list(object("Assignable element",{key:text,name:text,context:text,page:text,kind:text})),
  controls:list(object("Mapped control",{key:text,name:text})),sources:list(object("State source",{key:text,name:text,path:text})),
  cameras:list(object("Camera source",{key:text,name:text})),buttons:list(object("Button source",{key:text,name:text}))});
export const BRIDGE_OPERATIONS = {
  "GET /api/bridges": {response:object("Apple Home bridges",{bridges:list(object("Bridge and connection",{...bridgeDefinitionSchema.properties,status:bridgeStatusSchema}))})},
  "POST /api/bridges": {request:bridgeCreateSchema,response:object("Created bridge",{bridge:bridgeDefinitionSchema,page:text}),status:201},
  "GET /api/bridges/catalog": {response:bridgeCatalogSchema},
  "GET /api/bridges/options/:key": {response:object("Element bridge selections",{eligible:flag,bridges:list(object("Bridge selection",{id:text,name:text,protocol,revision,enabled:flag,member:{anyOf:[bridgeMembershipsSchema.items,{type:"null"}]},automatic:list(object("Automatic accessory",{name:text,profile:text}))}))})},
  "GET /api/bridges/:id": {response:object("Bridge settings and connection",{bridge:bridgeDefinitionSchema,status:bridgeStatusSchema,items:list(sharedItemSchema)})},
  "GET /api/bridges/:id/stream": {produces:"text/event-stream",frames:{status:bridgeStatusSchema}},
  "PUT /api/bridges/:id": {request:bridgeUpdateSchema,response:bridgeResponse},
  "DELETE /api/bridges/:id": {request:revisionRequest,response:object("Removed bridge",{removed:{const:true}})},
  "PUT /api/bridges/:id/members/:key": {request:object("Assign element",{revision,mappings:bridgeMembershipsSchema.items.properties.mappings,accessories:accessoryOverrides},["revision","mappings"]),response:bridgeResponse},
  "DELETE /api/bridges/:id/members/:key": {request:revisionRequest,response:bridgeResponse},
  "POST /api/bridges/:id/pair": {response:object("Pairing window opened",{ok:{const:true}})},
  "GET /api/bridges/:id/qr": {response:text,produces:"image/svg+xml",query:{accessory:text}},
};
