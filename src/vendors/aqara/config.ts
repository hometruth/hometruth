import { lanHostSchema } from "../../models/device";
export const homeKitConfigProperties = {
  host: lanHostSchema,
  port: { type: "integer", minimum: 1, maximum: 65535 },
  homekitId: { type: "string", pattern: "^(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}$" },
} as const;
