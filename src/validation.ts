import { healthCheckSchema, type HealthCheck } from "./health/model";
import { cooktopSchema } from "./models/cooktop-schema";
import { sensorSchema, temperatureSensorSchema, humiditySensorSchema, batterySensorSchema, sensorCollectionSchema, occupancySensorSchema, contactSensorSchema, hubSchema } from "./models/sensor-schemas";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { eventType } from "./models/event-types";
import { eventSchema, type Event } from "./models/event-schema";
import {
  appConfigSchema,
  deviceConnectionTypeSchema,
  binarySwitchSchema,
  buttonSchema,
  buttonPressRequestSchema,
  workflowSchema,
  workflowButtonCreateRequestSchema,
  workflowButtonUpdateRequestSchema,
  optimisticSwitchCreateRequestSchema,
  optimisticSwitchCreateResponseSchema,
  cameraActionResponseSchema,
  cameraControlRequestSchema,
  cameraDashboardModelSchema,
  cameraDiscoverRequestSchema,
  cameraPtzRequestSchema,
  cameraSchema,
  cameraSelectRequestSchema,
  cameraSetupRequestSchema,
  cameraNetworkReconnectRequestSchema,
  cameraRebootRequestSchema,
  deviceControlRequestSchema,
  deviceEnabledSchema,
  deviceRoomRequestSchema,
  deviceRenameRequestSchema,
  deviceRenameResponseSchema,
  deviceDetailResponseSchema,
  deviceEventsResponseSchema,
  eventsResponseSchema,
  modelListResponseSchema,
  serviceListResponseSchema,
  serviceEventsResponseSchema,
  eventTypeCatalogResponseSchema,
  cameraNetworkToggleRequestSchema,
  deviceListResponseSchema,
  devicesConfigSchema,
  devProjectSchema,
  errorResponseSchema,
  healthResponseSchema,
  homeTruthObjectSchema,
  hubDiscoverySchema,
  infraredBlasterSchema,
  infraredReceiverSchema,
  irRfBlasterDeviceSchema,
  irRfBlasterLearnRequestSchema,
  irRfBlasterLearnResponseSchema,
  irRfBlasterSaveCodeRequestSchema,
  irRfBlasterSendCodeRequestSchema,
  irRfBlasterSendRequestSchema,
  irRfBlasterUpdateCodeRequestSchema,
  irRfCodesFileSchema,
  secretsFileSchema,
  sourceRegionSchema,
  cameraRegionResponseSchema,
  lightSchema,
  stringLightSchema,
  sensorDeviceSchema,
  cameraMotionSensorSchema,
  motionSensorSchema,
  petTreatDispenserCameraSchema,
  radioFrequencyBlasterSchema,
  radioFrequencyReceiverSchema,
  registrationResponseSchema,
  schemaCatalogEntrySchema,
  schemaCatalogResponseSchema,
  schemaDocumentSchema,
  speakerSchema,
  televisionSchema,
  samsungFrameSchema,
  treatDispenserSchema,
  unregisterRequestSchema,
  unregisterResponseSchema,
  type AppConfig,
  type BinarySwitch,
  type Button,
  type ButtonPressRequest,
  type Workflow,
  type WorkflowButtonCreateRequest,
  type WorkflowButtonUpdateRequest,
  type OptimisticSwitchCreateRequest,
  type OptimisticSwitchCreateResponse,
  type Camera,
  type CameraActionResponse,
  type CameraControlRequest,
  type CameraDashboardModelContract,
  type CameraDiscoverRequest,
  type CameraPtzRequest,
  type CameraSelectRequest,
  type CameraSetupRequest,
  type CameraNetworkReconnectRequest,
  type CameraRebootRequest,
  type DeviceControlRequest,
  type DeviceEnabled,
  type DeviceRoomRequest,
  type DeviceRenameRequest,
  type DeviceRenameResponse,
  type DeviceEventsResponse,
  type EventsResponse,
  type ModelListResponse,
  type ServiceListResponse,
  type ServiceEventsResponse,
  type EventTypeCatalogResponse,
  type CameraNetworkToggleRequest,
  type DevProject,
  type DeviceListResponse,
  type DevicesConfig,
  type ErrorResponse,
  type HealthResponse,
  type HomeTruthObject,
  type HubDiscovery,
  type InfraredBlaster,
  type InfraredReceiver,
  type IrRfBlasterDocument,
  type IrRfBlasterLearnRequest,
  type IrRfBlasterLearnResponse,
  type IrRfBlasterSaveCodeRequest,
  type IrRfBlasterSendCodeRequest,
  type IrRfBlasterSendRequest,
  type IrRfBlasterUpdateCodeRequest,
  type IrRfCodesFile,
  type SecretsFile,
  type SourceRegion,
  type CameraRegionResponse,
  type Light,
  type MotionSensor,
  type CameraMotionSensor,
  type PetTreatDispenserCamera,
  type RadioFrequencyBlaster,
  type RadioFrequencyReceiver,
  type RegistrationResponse,
  type SchemaCatalogEntry,
  type SchemaCatalogResponse,
  type SchemaDocument,
  type Speaker,
  type Television,
  type SamsungFrame,
  type TreatDispenser,
  type UnregisterRequest,
  type UnregisterResponse,
} from "./schemas";

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});

addFormats(ajv);

const orderedRangeProperties = [
  ["minLeaseMs", "maxLeaseMs"],
  ["minimumPercent", "maximumPercent"],
  ["minimumKelvin", "maximumKelvin"],
  ["minimumMs", "maximumMs"],
  ["minRepeatCount", "maxRepeatCount"],
  ["minCaptureMs", "maxCaptureMs"],
  ["minimumPortions", "maximumPortions"],
] as const;

interface InvalidRange {
  instancePath: string;
  minimumProperty: string;
  maximumProperty: string;
}

function escapedJsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function findInvalidRange(value: unknown, instancePath = ""): InvalidRange | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const invalid = findInvalidRange(item, `${instancePath}/${index}`);
      if (invalid) return invalid;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const [minimumProperty, maximumProperty] of orderedRangeProperties) {
    const minimum = record[minimumProperty];
    const maximum = record[maximumProperty];
    if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
      return {
        instancePath: `${instancePath}/${escapedJsonPointerToken(maximumProperty)}`,
        minimumProperty,
        maximumProperty,
      };
    }
  }

  for (const [property, nested] of Object.entries(record)) {
    const invalid = findInvalidRange(nested, `${instancePath}/${escapedJsonPointerToken(property)}`);
    if (invalid) return invalid;
  }
  return undefined;
}

/** JSON Schema cannot compare two sibling values, so range ordering is the one
 * semantic invariant layered on top of the portable schema documents. */
function withOrderedRanges<T>(schemaValidator: ValidateFunction<T>): ValidateFunction<T> {
  const validator = ((data: unknown): data is T => {
    if (!schemaValidator(data)) {
      validator.errors = schemaValidator.errors ?? null;
      return false;
    }

    const invalid = findInvalidRange(data);
    if (!invalid) {
      validator.errors = null;
      return true;
    }

    validator.errors = [{
      keyword: "orderedRange",
      instancePath: invalid.instancePath,
      schemaPath: "#/x-hometruth-invariants/orderedRange",
      params: {
        minimumProperty: invalid.minimumProperty,
        maximumProperty: invalid.maximumProperty,
      },
      message: `must be greater than or equal to ${invalid.minimumProperty}`,
    }];
    return false;
  }) as ValidateFunction<T>;
  validator.schema = schemaValidator.schema;
  validator.schemaEnv = schemaValidator.schemaEnv;
  return validator;
}

const cameraValidator = withOrderedRanges(ajv.compile<Camera>(cameraSchema));
const eventValidator = ajv.compile<Event>(eventSchema);
const deviceConnectionTypeValidator = ajv.compile(deviceConnectionTypeSchema);
const stringLightValidator = withOrderedRanges(ajv.compile(stringLightSchema));
const lightValidator = withOrderedRanges(ajv.compile<Light>(lightSchema));
const binarySwitchValidator = ajv.compile<BinarySwitch>(binarySwitchSchema);
const buttonValidator = ajv.compile<Button>(buttonSchema);
const workflowValidator = ajv.compile<Workflow>(workflowSchema);
const temperatureSensorValidator = ajv.compile(temperatureSensorSchema);
const humiditySensorValidator = ajv.compile(humiditySensorSchema);
const batterySensorValidator = ajv.compile(batterySensorSchema);
const sensorValidator = ajv.compile(sensorSchema);
const cooktopValidator = ajv.compile(cooktopSchema);
const sensorCollectionValidator = ajv.compile(sensorCollectionSchema);
const occupancySensorValidator = ajv.compile(occupancySensorSchema);
const contactSensorValidator = ajv.compile(contactSensorSchema);
const hubValidator = ajv.compile(hubSchema);
const motionSensorValidator = withOrderedRanges(ajv.compile<MotionSensor>(motionSensorSchema));
const infraredBlasterValidator = withOrderedRanges(ajv.compile<InfraredBlaster>(infraredBlasterSchema));
const infraredReceiverValidator = withOrderedRanges(ajv.compile<InfraredReceiver>(infraredReceiverSchema));
const radioFrequencyBlasterValidator = withOrderedRanges(ajv.compile<RadioFrequencyBlaster>(radioFrequencyBlasterSchema));
const radioFrequencyReceiverValidator = withOrderedRanges(ajv.compile<RadioFrequencyReceiver>(radioFrequencyReceiverSchema));
const irRfBlasterDeviceValidator = withOrderedRanges(ajv.compile<IrRfBlasterDocument>(irRfBlasterDeviceSchema));
const treatDispenserValidator = withOrderedRanges(ajv.compile<TreatDispenser>(treatDispenserSchema));
const speakerValidator = withOrderedRanges(ajv.compile<Speaker>(speakerSchema));
const televisionValidator = withOrderedRanges(ajv.compile<Television>(televisionSchema));
const homeTruthObjectValidator = withOrderedRanges(ajv.compile<HomeTruthObject>(homeTruthObjectSchema));
const petTreatDispenserCameraValidator = withOrderedRanges(
  ajv.compile<PetTreatDispenserCamera>(petTreatDispenserCameraSchema),
);
const cameraMotionSensorValidator = withOrderedRanges(
  ajv.compile<CameraMotionSensor>(cameraMotionSensorSchema),
);
const samsungFrameValidator = withOrderedRanges(ajv.compile<SamsungFrame>(samsungFrameSchema));
const cameraDashboardModelValidator = ajv.compile<CameraDashboardModelContract>(cameraDashboardModelSchema);
const schemaDocumentValidator = ajv.compile<SchemaDocument>(schemaDocumentSchema);
const schemaCatalogEntryValidator = ajv.compile<SchemaCatalogEntry>(schemaCatalogEntrySchema);

export const validators = {
  healthCheck: ajv.compile<HealthCheck>(healthCheckSchema),
  event: eventValidator,
  appConfig: ajv.compile<AppConfig>(appConfigSchema),
  deviceConnectionType: deviceConnectionTypeValidator,
  binarySwitch: binarySwitchValidator,
  button: buttonValidator,
  buttonPressRequest: ajv.compile<ButtonPressRequest>(buttonPressRequestSchema),
  workflow: workflowValidator,
  workflowButtonCreateRequest: ajv.compile<WorkflowButtonCreateRequest>(workflowButtonCreateRequestSchema),
  workflowButtonUpdateRequest: ajv.compile<WorkflowButtonUpdateRequest>(workflowButtonUpdateRequestSchema),
  optimisticSwitchCreateRequest: ajv.compile<OptimisticSwitchCreateRequest>(optimisticSwitchCreateRequestSchema),
  optimisticSwitchCreateResponse: ajv.compile<OptimisticSwitchCreateResponse>(optimisticSwitchCreateResponseSchema),
  camera: cameraValidator,
  cameraActionResponse: ajv.compile<CameraActionResponse>(cameraActionResponseSchema),
  cameraControlRequest: ajv.compile<CameraControlRequest>(cameraControlRequestSchema),
  cameraDashboardModel: cameraDashboardModelValidator,
  cameraDiscoverRequest: ajv.compile<CameraDiscoverRequest>(cameraDiscoverRequestSchema),
  cameraPtzRequest: ajv.compile<CameraPtzRequest>(cameraPtzRequestSchema),
  cameraSelectRequest: ajv.compile<CameraSelectRequest>(cameraSelectRequestSchema),
  cameraSetupRequest: ajv.compile<CameraSetupRequest>(cameraSetupRequestSchema),
  cameraNetworkToggleRequest: ajv.compile<CameraNetworkToggleRequest>(cameraNetworkToggleRequestSchema),
  cameraNetworkReconnectRequest: ajv.compile<CameraNetworkReconnectRequest>(cameraNetworkReconnectRequestSchema),
  cameraRebootRequest: ajv.compile<CameraRebootRequest>(cameraRebootRequestSchema),
  deviceControlRequest: ajv.compile<DeviceControlRequest>(deviceControlRequestSchema),
  deviceEnabled: ajv.compile<DeviceEnabled>(deviceEnabledSchema),
  deviceRoomRequest: ajv.compile<DeviceRoomRequest>(deviceRoomRequestSchema),
  deviceRenameRequest: ajv.compile<DeviceRenameRequest>(deviceRenameRequestSchema),
  deviceRenameResponse: ajv.compile<DeviceRenameResponse>(deviceRenameResponseSchema),
  deviceDetailResponse: ajv.compile<Record<string, unknown>>(deviceDetailResponseSchema),
  modelListResponse: ajv.compile<ModelListResponse>(modelListResponseSchema),
  serviceListResponse: ajv.compile<ServiceListResponse>(serviceListResponseSchema),
  eventTypeCatalogResponse: ajv.compile<EventTypeCatalogResponse>(eventTypeCatalogResponseSchema),
  serviceEventsResponse: ajv.compile<ServiceEventsResponse>(serviceEventsResponseSchema),
  deviceEventsResponse: ajv.compile<DeviceEventsResponse>(deviceEventsResponseSchema),
  eventsResponse: ajv.compile<EventsResponse>(eventsResponseSchema),
  devProject: ajv.compile<DevProject>(devProjectSchema),
  deviceListResponse: ajv.compile<DeviceListResponse>(deviceListResponseSchema),
  devicesConfig: ajv.compile<DevicesConfig>(devicesConfigSchema),
  errorResponse: ajv.compile<ErrorResponse>(errorResponseSchema),
  healthResponse: ajv.compile<HealthResponse>(healthResponseSchema),
  homeTruthObject: homeTruthObjectValidator,
  hubDiscovery: ajv.compile<HubDiscovery>(hubDiscoverySchema),
  infraredBlaster: infraredBlasterValidator,
  infraredReceiver: infraredReceiverValidator,
  irRfBlasterDevice: irRfBlasterDeviceValidator,
  irRfBlasterLearnRequest: ajv.compile<IrRfBlasterLearnRequest>(irRfBlasterLearnRequestSchema),
  irRfBlasterLearnResponse: ajv.compile<IrRfBlasterLearnResponse>(irRfBlasterLearnResponseSchema),
  irRfBlasterSaveCodeRequest: ajv.compile<IrRfBlasterSaveCodeRequest>(irRfBlasterSaveCodeRequestSchema),
  irRfBlasterSendRequest: ajv.compile<IrRfBlasterSendRequest>(irRfBlasterSendRequestSchema),
  irRfBlasterSendCodeRequest: ajv.compile<IrRfBlasterSendCodeRequest>(irRfBlasterSendCodeRequestSchema),
  irRfBlasterUpdateCodeRequest: ajv.compile<IrRfBlasterUpdateCodeRequest>(irRfBlasterUpdateCodeRequestSchema),
  irRfCodesFile: ajv.compile<IrRfCodesFile>(irRfCodesFileSchema),
  sourceRegion: ajv.compile<SourceRegion>(sourceRegionSchema),
  cameraRegionResponse: ajv.compile<CameraRegionResponse>(cameraRegionResponseSchema),
  secretsFile: ajv.compile<SecretsFile>(secretsFileSchema),
  light: lightValidator,
  stringLight: stringLightValidator,
  motionSensor: motionSensorValidator,
  sensor: sensorValidator,
  temperatureSensor: temperatureSensorValidator,
  humiditySensor: humiditySensorValidator,
  batterySensor: batterySensorValidator,
  sensorDevice: ajv.compile(sensorDeviceSchema),
  cooktop: cooktopValidator,
  sensorCollection: sensorCollectionValidator,
  occupancySensor: occupancySensorValidator,
  contactSensor: contactSensorValidator,
  hub: hubValidator,
  petTreatDispenserCamera: petTreatDispenserCameraValidator,
  cameraMotionSensor: cameraMotionSensorValidator,
  radioFrequencyBlaster: radioFrequencyBlasterValidator,
  radioFrequencyReceiver: radioFrequencyReceiverValidator,
  registrationResponse: ajv.compile<RegistrationResponse>(registrationResponseSchema),
  schemaCatalogEntry: schemaCatalogEntryValidator,
  schemaCatalogResponse: ajv.compile<SchemaCatalogResponse>(schemaCatalogResponseSchema),
  schemaDocument: schemaDocumentValidator,
  treatDispenser: treatDispenserValidator,
  speaker: speakerValidator,
  television: televisionValidator,
  samsungFrame: samsungFrameValidator,
  unregisterRequest: ajv.compile<UnregisterRequest>(unregisterRequestSchema),
  unregisterResponse: ajv.compile<UnregisterResponse>(unregisterResponseSchema),
} satisfies Record<string, ValidateFunction>;

/**
 * One compiled validator per event type in the catalog
 * (`src/models/event-types.ts`), built on first use. Event data is
 * validated at the moment it is recorded, so a service that emits a
 * malformed event fails at the emitter instead of writing a row nothing
 * can render.
 */
const eventDataValidators = new Map<string, ValidateFunction>();
let lastEventDataErrors: ErrorObject[] | null | undefined;

function eventDataValidator(typeId: string): ValidateFunction | undefined {
  const cached = eventDataValidators.get(typeId);
  if (cached) return cached;
  const definition = eventType(typeId);
  if (!definition) return undefined;
  const compiled = ajv.compile(definition.payloadSchema);
  eventDataValidators.set(typeId, compiled);
  return compiled;
}

/** True when `data` matches the schema of the event type `typeId`; an unknown type never matches. */
export function validateEventData(typeId: string, data: unknown): boolean {
  const validate = eventDataValidator(typeId);
  if (!validate) {
    lastEventDataErrors = undefined;
    return false;
  }
  const valid = validate(data);
  lastEventDataErrors = valid ? undefined : validate.errors;
  return valid;
}

/** Why the last `validateEventData` call failed, for the error the emitter sees. */
export function eventDataErrors(typeId: string): string {
  return eventDataValidator(typeId)
    ? describeValidationErrors(lastEventDataErrors)
    : `"${typeId}" is not a known event type`;
}

export function describeValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "Schema validation failed";

  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}
