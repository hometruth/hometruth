import { readControlPath } from "./ui/browser/control-routes";

export { readControlPath };

/** The controls accepted by the generic HTTP POST endpoints. */
export function postControlNames(device: {
  readonly id: string;
  controls(): readonly string[];
  resolveControl(reference: string): { kind: string; controlId: string };
}): readonly string[] {
  return device.controls().filter(reference => {
    const { kind, controlId } = device.resolveControl(reference);
    return readControlPath(device.id, kind, controlId) === undefined;
  });
}
