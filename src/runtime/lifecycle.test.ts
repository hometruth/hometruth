import { expect, test } from "bun:test";
import { Lifecycle } from "./lifecycle";

test("cleanup attempts every allocated resource even if one throws or hangs", async () => {
  const lifecycle = new Lifecycle(20);
  const closed: string[] = [];
  let finish!: () => void;
  lifecycle.defer(() => { closed.push("first"); });
  lifecycle.defer(() => { throw new Error("broken cleanup"); });
  lifecycle.defer(() => new Promise<void>(resolve => { closed.push("last"); finish = resolve; }));
  const stopping = lifecycle.close();
  await Bun.sleep(50);
  expect(closed).toEqual(["last", "first"]);
  expect(lifecycle.close()).toBe(stopping);
  finish();
  await stopping;
});
