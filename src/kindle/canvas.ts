import type { RegisteredDevice } from "../site";
import type { CanvasLayout, CanvasWidget, KindleConfig } from "./config";

/** Opening the designer creates a draft only; existing saved lists remain intact. */
export function canvasDraft(config: KindleConfig, devices: readonly RegisteredDevice[]): KindleConfig & { canvas: CanvasLayout } {
  if (config.canvas) return structuredClone(config) as KindleConfig & { canvas: CanvasLayout };
  const items = config.selection === "custom" ? config.items : devices.slice(0, 4).map((device) => ({ deviceId: device.id, capability: "auto" as const, mode: "auto" as const, label: "" }));
  const widgets: CanvasWidget[] = [
    { id: "heading", kind: "text", text: config.title, x: 24, y: 24, width: 392, height: 112, fontSize: 40, align: "left", border: false },
    { id: "clock", kind: "clock", format: "dateTime", x: 440, y: 24, width: 294, height: 112, fontSize: 24, align: "right", border: false },
    { id: "divider", kind: "rule", x: 24, y: 144, width: 710, height: 4, fontSize: 22, align: "left", border: false },
    ...items.slice(0, 4).map((item, index): CanvasWidget => ({ ...item, id: `device-${index}`, kind: "device", showLabel: true, x: 24 + (index % 2) * 366, y: 168 + Math.floor(index / 2) * 244, width: 344, height: 220, fontSize: 24, align: "left", border: false })),
  ];
  return { ...structuredClone(config), canvas: { width: 758, height: 1024, grid: 8, widgets } };
}
