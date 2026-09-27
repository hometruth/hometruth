import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  binarySwitchSchema,
  cameraDashboardModelSchema,
  deviceListResponseSchema,
  devProjectSchema,
  errorResponseSchema,
  healthResponseSchema,
  hubDiscoverySchema,
  schemaCatalogEntrySchema,
  schemaCatalogResponseSchema,
  schemaDocumentSchema,
} from "../../src/schemas";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.compile(schemaDocumentSchema);
ajv.compile(schemaCatalogEntrySchema);

export const testValidators = {
  binarySwitch: ajv.compile(binarySwitchSchema),
  cameraDashboardModel: ajv.compile(cameraDashboardModelSchema),
  deviceListResponse: ajv.compile(deviceListResponseSchema),
  devProject: ajv.compile(devProjectSchema),
  errorResponse: ajv.compile(errorResponseSchema),
  healthResponse: ajv.compile(healthResponseSchema),
  hubDiscovery: ajv.compile(hubDiscoverySchema),
  schemaCatalogResponse: ajv.compile(schemaCatalogResponseSchema),
};
