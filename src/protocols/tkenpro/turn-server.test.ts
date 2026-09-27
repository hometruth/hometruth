import { describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { MeariTurnClient } from "./turn.ts";
import {
  encodeMeariTurnChannelData,
  MeariLocalTurnServer,
} from "./turn-server.ts";

describe("Meari local TURN server", () => {
  test("matches the camera SDK's unpadded UDP ChannelData framing", () => {
    const payload = Buffer.alloc(325, 0x5a);
    const frame = encodeMeariTurnChannelData(0x4f6b, payload);
    expect(frame.byteLength).toBe(330);
    expect(frame.readUInt16BE(0)).toBe(0x4f6b);
    expect(frame.readUInt16BE(2)).toBe(326);
    expect(frame.subarray(4, -1)).toEqual(payload);
    expect(frame.at(-1)).toBe(0);
  });

  test("challenges and accepts a short-lived authorized allocation", async () => {
    const allocations: string[] = [];
    const server = new MeariLocalTurnServer({
      host: "127.0.0.1",
      port: 0,
      advertisedHost: "127.0.0.1",
      allowSourceAddress: (address) => address === "127.0.0.1",
      onAllocation: (source) => allocations.push(`${source.ip}:${source.port}`),
    });
    const port = await server.start();
    const release = server.authorizeCredential("local-camera", "local-password");
    const client = new MeariTurnClient({
      serverIp: "127.0.0.1",
      serverPort: port,
      username: "local-camera",
      password: "local-password",
      realm: "hometruth",
    });
    try {
      const allocation = await client.allocate();
      expect(allocation.relay).toEqual({ ip: "127.0.0.1", port });
      expect(allocation.mapped?.ip).toBe("127.0.0.1");
      expect(allocations).toHaveLength(1);
      expect(server.allocationCount).toBe(1);
      await client.refresh();
      await client.createPermission("127.0.0.1");
      expect(await client.channelBind({ ip: "127.0.0.1", port: 40_000 })).toBe(0x4000);
    } finally {
      client.close();
      release();
      await server.stop();
    }
  });

  test("relays Meari ChannelData in both directions for one authorized allocation", async () => {
    const server = new MeariLocalTurnServer({
      host: "127.0.0.1",
      port: 0,
      advertisedHost: "127.0.0.1",
      allowSourceAddress: (address) => address === "127.0.0.1",
    });
    const port = await server.start();
    const release = server.authorizeCredential("camera", "password");
    const camera = new MeariTurnClient({
      serverIp: "127.0.0.1",
      serverPort: port,
      username: "camera",
      password: "password",
      realm: "hometruth",
      bindAddress: "127.0.0.1",
    });
    const peer = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      peer.once("error", reject);
      peer.bind(0, "127.0.0.1", () => {
        peer.off("error", reject);
        resolve();
      });
    });
    try {
      await camera.allocate();
      const address = peer.address();
      if (typeof address === "string") throw new Error("Peer socket omitted its UDP port");
      const peerAddress = { ip: "127.0.0.1", port: address.port };
      await camera.createPermission(peerAddress.ip);
      await camera.channelBind(peerAddress);

      peer.send(Buffer.from("peer-to-camera"), port, "127.0.0.1");
      const atCamera = await camera.receive(2_000);
      expect(atCamera.viaTurn).toBeTrue();
      expect(atCamera.data.subarray(0, -1).toString()).toBe("peer-to-camera");
      expect(atCamera.data.at(-1)).toBe(0);

      const atPeer = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Peer relay timed out")), 2_000);
        peer.once("message", (bytes) => {
          clearTimeout(timer);
          resolve(Buffer.from(bytes));
        });
      });
      await camera.sendToPeer(peerAddress, Buffer.from("camera-to-peer"));
      expect((await atPeer).toString()).toBe("camera-to-peer");
      expect(server.relayedPacketCount).toBe(2);
    } finally {
      peer.close();
      camera.close();
      release();
      await server.stop();
    }
  });
});
