import { expect, test } from "bun:test";
import { forwardToWorker } from "./proxy";

const upstream = new URL("http://127.0.0.1:1234/hubs/aqara-hub-m2/graph");

test("a healthy page can finish after the former 1.5-second cutoff", async () => {
  const request = new Request("http://localhost:3000/hubs/aqara-hub-m2/graph");
  const response = await forwardToWorker(request, upstream, new Headers(), async (_url, init) => {
    await Bun.sleep(1_750);
    init.signal?.throwIfAborted();
    return new Response("Aqara Hub M2 graph");
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("Aqara Hub M2 graph");
});

test("disconnecting the client still cancels pending upstream work", async () => {
  const controller = new AbortController();
  const request = new Request("http://localhost:3000/graph", { signal: controller.signal });
  const pending = forwardToWorker(request, upstream, new Headers(), (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  controller.abort(new Error("Client disconnected"));
  await expect(pending).rejects.toThrow("Client disconnected");
});

test("forwards commands and streaming responses without following redirects or buffering", async () => {
  const request = new Request("http://localhost:3000/api/command", { method: "POST", body: "command" });
  const headers = new Headers({ "x-hometruth-worker-token": "test-token" });
  const response = new Response(new ReadableStream(), { status: 307, headers: { location: "/result", "set-cookie": "session=test" } });
  const result = await forwardToWorker(request, upstream, headers, async (url, init) => {
    expect(url).toBe(upstream);
    expect(init.method).toBe("POST");
    expect(init.headers).toBe(headers);
    expect(init.body).toBe(request.body);
    expect(await new Response(init.body).text()).toBe("command");
    expect(init.redirect).toBe("manual");
    return response;
  });
  expect(result).toBe(response);
  await result.body!.cancel();
});

test("an upstream failure propagates without replaying a command", async () => {
  let calls = 0;
  const request = new Request("http://localhost:3000/api/command", { method: "POST", body: "command" });
  await expect(forwardToWorker(request, upstream, new Headers(), async () => {
    calls++;
    throw new Error("Connection closed");
  })).rejects.toThrow("Connection closed");
  expect(calls).toBe(1);
});
