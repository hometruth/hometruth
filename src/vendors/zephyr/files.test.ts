import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "./controller";
import { readState, savePrivate } from "./files";
import { authorizedAdmin, readCommandBody } from "./server";

test("state round trip is private and corrupt state is not silently reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zephyr-test-"));
  try {
    expect(await readState(directory)).toEqual(initialState());
    await savePrivate(join(directory, "state.json"), initialState());
    expect((await stat(join(directory, "state.json"))).mode & 0o777).toBe(0o600);
    expect(await readState(directory)).toEqual(initialState());
    await writeFile(join(directory, "state.json"), "not json");
    await expect(readState(directory)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("loopback API requires the full bearer token", () => {
  expect(authorizedAdmin(undefined, "abc")).toBe(false);
  expect(authorizedAdmin("Bearer ab", "abc")).toBe(false);
  expect(authorizedAdmin("Bearer abd", "abc")).toBe(false);
  expect(authorizedAdmin("Bearer abc", "abc")).toBe(true);
});
test("HTTP command parser bounds chunked bodies and rejects malformed JSON without a listener", async () => {
  async function* body(...chunks: string[]) { for (const chunk of chunks) yield Buffer.from(chunk); }
  expect(await readCommandBody(body('{"fan":', "1}"))).toEqual({ fan: 1 });
  await expect(readCommandBody(body("{"))).rejects.toThrow("Invalid JSON");
  await expect(readCommandBody(body("x".repeat(3000), "y".repeat(3000)))).rejects.toThrow("too large");
});
