import { expect, test } from "bun:test";
import { PERMISSIONS, permits, validateTokenCreate, type Permission } from "./model";
import { Principal } from "./scope";

test("read, write and admin form a hierarchy within the token's scope", () => {
  const required = ["read", "write", "admin"] as const;
  const grants = [[true, false, false], [true, true, false], [true, true, true]];
  expect(PERMISSIONS).toEqual(required);
  for (const [index, held] of required.entries()) {
    const principal = new Principal({
      kid: "test", name: held, permissions: [held], subject: { device: "gate-relay" }, createdAt: new Date().toISOString(),
    }, { deviceGroups: [], automaticGroupMembers: () => [] });
    expect(required.map(permission => principal.allowsDevice("gate-relay", permission))).toEqual(grants[index]!);
    expect(required.map(permission => principal.allowsDevice("other-relay", permission))).toEqual([false, false, false]);
    expect(required.map(permission => principal.allowsSite(permission))).toEqual([false, false, false]);
  }
});

test("only the current access levels and exactly one subject are accepted", () => {
  const base = { name: "Gate", subject: { device: "gate-relay" } };
  for (const permission of PERMISSIONS) expect(validateTokenCreate({ ...base, permissions: [permission] })).toBe(true);
  for (const removed of ["control", "media", "events", "owner"]) {
    expect(validateTokenCreate({ ...base, permissions: [removed] })).toBe(false);
    expect(PERMISSIONS.map(required => permits([removed as Permission], required))).toEqual([false, false, false]);
  }
  expect(validateTokenCreate({ ...base, permissions: [] })).toBe(false);
  expect(validateTokenCreate({ ...base, permissions: ["admin"], subject: { device: "gate-relay", all: true } })).toBe(false);
  expect(validateTokenCreate({ ...base, permissions: ["admin"], subject: { device: "" } })).toBe(false);
});
