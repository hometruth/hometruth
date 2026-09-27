import { expect, test } from "bun:test";
import { revealCredentials } from "./credentials";

test("REVEAL supports the operator's TATACAM environment spelling", () => {
  expect(revealCredentials({}, { REVEAL_TATACAM_USER: "owner@example.com", REVEAL_TATACAM_PASSWORD: "example-password" }))
    .toEqual({ email: "owner@example.com", password: "example-password" });
  expect(revealCredentials({}, {})).toEqual({ email: "", password: "" });
});

test("REVEAL uses one credential source and preserves password whitespace", () => {
  const env = { REVEAL_TACTACAM_USER: "primary@example.com", REVEAL_TACTACAM_PASSWORD: " primary ", REVEAL_TATACAM_USER: "alias@example.com", REVEAL_TATACAM_PASSWORD: "alias" };
  expect(revealCredentials({}, env)).toEqual({ email: "primary@example.com", password: " primary " });
  expect(revealCredentials({ email: "device@example.com", password: " device " }, env)).toEqual({ email: "device@example.com", password: " device " });
  expect(revealCredentials({ email: "device@example.com" }, env)).toEqual({ email: "device@example.com", password: "" });
  expect(revealCredentials({}, { REVEAL_TACTACAM_USER: "primary@example.com", REVEAL_TATACAM_PASSWORD: "alias" })).toEqual({ email: "primary@example.com", password: "" });
});
