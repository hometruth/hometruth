export const API_PAGE_PATTERNS = [
  "", "/devices", "/switches", "/buttons", "/groups", "/services", "/automations", "/schemas", "/kindle", "/tags", "/tags/:slug", "/tags/:name/:slug",
  ...["devices", "switches", "lights", "string-lights", "buttons", "cameras", "sensors", "hubs", "blasters", "speakers", "groups", "services", "automations"].map(prefix => `/${prefix}/:slug`),
  "/elements/:key", "/schemas/:schema", "/kindle/designer",
];
export const API_FILES = ["SKILL.md", "openapi.json"] as const;
