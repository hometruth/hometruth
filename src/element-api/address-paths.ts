/** Serializable current names for the public transport; stored identities stay internal. */
export interface ApiAddressMappings {
  readonly devices: Readonly<Record<string, string>>;
  readonly groups: Readonly<Record<string, string>>;
  readonly services: Readonly<Record<string, string>>;
  readonly elements: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly stateNodes: Readonly<Record<string, string>>;
}

/** Kept self-contained so the same formatter can run in the browser shell. */
export function publicApiPath(path: string, mappings: ApiAddressMappings): string {
  const boundary = path.search(/[?#]/);
  const pathname = boundary < 0 ? path : path.slice(0, boundary);
  let suffix = boundary < 0 ? "" : path.slice(boundary);
  const parts = pathname.split("/");
  const replace = (index: number, names: Readonly<Record<string, string>>) => {
    if (!parts[index]) return;
    let id: string;
    try { id = decodeURIComponent(parts[index]!); } catch { return; }
    const address = Object.hasOwn(names, id) ? names[id] : undefined;
    if (address) parts[index] = encodeURIComponent(address);
  };
  if (["/graph", "/api/graph/scene"].includes(pathname) && suffix.startsWith("?")) {
    const hash = suffix.indexOf("#");
    const query = new URLSearchParams(hash < 0 ? suffix.slice(1) : suffix.slice(1, hash));
    const formatted = new URLSearchParams();
    for (const [key, value] of query) {
      let address = value;
      if (["focus", "selected", "expand"].includes(key) && Object.hasOwn(mappings.elements, value)) address = mappings.elements[value]!;
      else if (key === "expand") {
        try {
          const group: unknown = JSON.parse(value);
          if (Array.isArray(group) && group.length === 2 && group[0] === "room" && typeof group[1] === "string" && Object.hasOwn(mappings.elements, group[1])) address = JSON.stringify(["room", mappings.elements[group[1]]]);
        } catch { /* An ordinary expanded node is not a group descriptor. */ }
      }
      formatted.append(key, address);
    }
    suffix = `?${formatted}${hash < 0 ? "" : suffix.slice(hash)}`;
  }
  if (parts[1] === "elements") replace(2, mappings.elements);
  if (parts[1] !== "api") return parts.join("/") + suffix;
  const collection = parts[2];
  if (["devices", "switches", "lights", "buttons", "cameras", "ir-rf-blasters", "radio-receivers", "aqara"].includes(collection!)) replace(3, mappings.devices);
  else if (collection === "device-groups" && parts[3] !== "preview") replace(3, mappings.groups);
  else if (collection === "services") {
    // Frigate's camera names and object tracks belong to its vendor API.
    if (!(parts[3] === "frigate" && ["frames", "previews"].includes(parts[4]!))) replace(3, mappings.services);
  } else if (collection === "elements") {
    replace(3, mappings.elements);
    if (collection === "elements" && parts[4] === "tags") replace(5, mappings.tags);
  } else if (collection === "tags" && !["export", "import"].includes(parts[3]!)) replace(3, mappings.tags);
  else if (collection === "bridges") {
    if (parts[3] === "options") replace(4, mappings.elements);
    else if (parts[4] === "members") replace(5, mappings.elements);
  }
  if (collection === "state" && suffix.startsWith("?")) {
    const hash = suffix.indexOf("#");
    const query = new URLSearchParams(hash < 0 ? suffix.slice(1) : suffix.slice(1, hash));
    const formatted = new URLSearchParams();
    for (const [key, value] of query) formatted.append(key, key === "node" && Object.hasOwn(mappings.stateNodes, value) ? mappings.stateNodes[value]! : value);
    suffix = `?${formatted}${hash < 0 ? "" : suffix.slice(hash)}`;
  }
  return parts.join("/") + suffix;
}
