import { describe, expect, test } from "bun:test";
import { Subscribe } from "@matter/main/protocol";
import { AttributeId, ClusterId } from "@matter/main/types";

/**
 * The one thing `worker.ts` depends on that its types cannot state.
 *
 * `Subscribe.Options` declares an `update` callback, so passing one compiles. `Subscribe()` does
 * not copy it: it builds a fresh request through `Read()` and adds exactly `keepSubscriptions`,
 * `minIntervalFloor` and `maxIntervalCeiling`. With the request's own `updated` left unset,
 * `ClientInteraction` drains every DataReport into `for await (const _chunk of result);` and
 * throws it away — no error, no closed subscription, nothing in any log. That is how this hub came
 * to report once at startup and never again while every reading in the house quietly froze.
 *
 * If a matter.js upgrade ever starts honouring the option, the first two assertions fail: delete
 * them, and leave the rest, because assigning the callbacks onto the request stays correct either
 * way. If it renames `updated`, the last assertion fails, and that one is a real break.
 */
describe("matter.js subscribe requests", () => {
  test("carry their callbacks on the request, not in the options handed to Subscribe()", () => {
    const options = {
      attributes: [{ clusterId: ClusterId(0x45), attributeId: AttributeId(0) }],
      keepSubscriptions: true,
      update: async () => {},
      closed: () => {},
    };
    const request = Subscribe(options);

    expect(request.updated).toBeUndefined();
    expect(request.closed).toBeUndefined();

    const updated = async () => {};
    const closed = () => {};
    request.updated = updated;
    request.closed = closed;
    expect(request.updated).toBe(updated);
    expect(request.closed).toBe(closed);
  });
});
