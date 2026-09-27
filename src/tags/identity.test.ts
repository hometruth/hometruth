import { expect, test } from "bun:test";
import { elementKey, isElementKey, isTaggableKey, parseElementKey } from "./identity";

test("the site's only canonical key is the reserved name root", () => {
  expect(elementKey("site")).toBe("root");
  expect(isElementKey("root")).toBe(true);
  expect(isTaggableKey("root")).toBe(true);
  expect(parseElementKey("root")).toEqual({ kind: "site", ids: ["root"] });
  for (const id of ["root", "hometruth"]) {
    const encoded = Buffer.from(JSON.stringify(["site", id])).toString("base64url");
    expect(isElementKey(encoded)).toBe(false);
    expect(parseElementKey(encoded)).toBeUndefined();
  }
});

test("a device named root has its own scoped key", () => {
  const device = elementKey("device", "root");
  expect(device).not.toBe("root");
  expect(isTaggableKey(device)).toBe(true);
  expect(parseElementKey(device)).toEqual({ kind: "device", ids: ["root"] });
});
