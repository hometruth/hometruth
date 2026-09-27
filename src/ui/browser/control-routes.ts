/** Read operations have their own GET resources instead of POST control routes. */
export function readControlPath(id: string, kind: string, controlId: string): string | undefined {
  if (kind === "binarySwitch" && controlId === "getState") return `/api/switches/${encodeURIComponent(id)}/state`;
  return undefined;
}
