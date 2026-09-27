import { describe, expect, test } from "bun:test";
import {
  decodeMeariPolygonRegions,
  encodeMeariPolygonRegions,
} from "./polygon-region-codecs.ts";

const octagon = [
  { x: 40, y: 40 }, { x: 50, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 50 },
  { x: 60, y: 60 }, { x: 50, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 50 },
];

describe("Meari polygon-region codec", () => {
  test("encodes the exact flat percentage array used by CloudEdge property 232", () => {
    expect(encodeMeariPolygonRegions({
      polygons: [{ type: 3, vId: 4, aiTypes: [1, 7], points: octagon }],
    })).toEqual([{
      v_id: 4,
      type: 3,
      points: [40, 40, 50, 40, 60, 40, 60, 50, 60, 60, 50, 60, 40, 60, 40, 50],
      ai_type: [1, 7],
    }]);
  });

  test("decodes empty and populated firmware strings without exposing raw JSON", () => {
    expect(decodeMeariPolygonRegions("")).toEqual({ polygons: [], maxPolygons: 6, pointCount: 8 });
    expect(decodeMeariPolygonRegions(JSON.stringify([{
      type: 1,
      points: octagon.flatMap((point) => [point.x, point.y]),
    }]))?.polygons[0]?.points).toEqual(octagon);
  });

  test("rounds coordinates exactly as the app does", () => {
    expect(encodeMeariPolygonRegions([{
      type: 1,
      points: octagon.map((point, index) => ({ x: point.x + (index === 0 ? 0.5 : 0), y: point.y })),
    }])).toEqual([expect.objectContaining({
      points: [41, 40, 50, 40, 60, 40, 60, 50, 60, 60, 50, 60, 40, 60, 40, 50],
    })]);
  });

  test("rejects too many polygons, wrong point counts, and out-of-range coordinates", () => {
    expect(() => encodeMeariPolygonRegions(Array.from({ length: 7 }, () => ({ type: 1, points: octagon })))).toThrow();
    expect(() => encodeMeariPolygonRegions([{ type: 1, points: octagon.slice(0, 4) }])).toThrow();
    expect(() => encodeMeariPolygonRegions([{ type: 1, points: octagon.map((point, index) => ({ ...point, x: index ? point.x : 101 })) }])).toThrow();
  });
});
