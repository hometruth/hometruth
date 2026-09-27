import { describe, expect, test } from "bun:test";
import { UniFiClient } from "./unifi";

function fixture(options: { conflict?: boolean; failVerify?: boolean; offline?: boolean; wired?: boolean } = {}) {
  const mac = "02:00:00:00:10:30";
  const user = { _id: "blaster", mac, use_fixedip: true, fixed_ip: "10.77.0.30", last_ip: "10.78.0.31", last_connection_network_id: "iot" };
  const writes: unknown[] = [];
  const client = new UniFiClient({ apiKey: "test", fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    let data: unknown[];
    if (init?.method === "PUT") {
      const fields = JSON.parse(String(init.body));
      writes.push(fields);
      if (!options.failVerify) Object.assign(user, fields);
      data = [user];
    } else if (path.endsWith("/stat/sta")) data = options.offline ? [] : [{ ...user, ip: "10.78.0.31", network_id: "iot", is_wired: options.wired === true }];
    else if (path.endsWith("/rest/networkconf")) data = [{ _id: "iot", name: "example-iot", ip_subnet: "10.78.0.1/24", dhcpd_enabled: true }];
    else data = [user, ...(options.conflict ? [{ mac: "aa:bb:cc:dd:ee:ff", use_fixedip: true, fixed_ip: "10.78.0.30" }] : [])];
    return Response.json({ meta: { rc: "ok" }, data });
  }) as typeof fetch });
  return { client, mac, user, writes };
}

describe("IP reservations", () => {
  test("moves a stale reservation into the current subnet, verifies it, and supports undo", async () => {
    const { client, mac, user, writes } = fixture();
    expect((await client.listAddressClients())[0]?.subnet).toBe("10.78.0.1/24");
    const undo = await client.reserveAddress(mac, "10.78.0.30");
    expect(user.fixed_ip).toBe("10.78.0.30");
    await undo();
    expect(user.fixed_ip).toBe("10.77.0.30");
    expect(writes).toHaveLength(2);
  });

  test("rejects wrong subnet, gateway, network, broadcast and malformed addresses before writing", async () => {
    const { client, mac, writes } = fixture();
    for (const ip of ["10.77.0.30", "10.78.0.1", "10.78.0.0", "10.78.0.255", "10.78.0.30oops"]) {
      await expect(client.reserveAddress(mac, ip)).rejects.toThrow();
    }
    expect(writes).toEqual([]);
  });

  test("rejects another device's reservation and unknown MACs", async () => {
    const { client, mac, writes } = fixture({ conflict: true });
    await expect(client.reserveAddress(mac, "10.78.0.30")).rejects.toThrow("already used or reserved");
    await expect(client.reserveAddress("aa:bb:cc:dd:ee:ff", "10.78.0.32")).rejects.toThrow("Select a known device");
    expect(writes).toEqual([]);
  });

  test("restores the prior reservation when readback fails", async () => {
    const { client, mac, writes } = fixture({ failVerify: true });
    await expect(client.reserveAddress(mac, "10.78.0.30")).rejects.toThrow("did not retain");
    expect(writes).toEqual([{ use_fixedip: true, fixed_ip: "10.78.0.30" }, { use_fixedip: true, fixed_ip: "10.77.0.30" }]);
  });
});

for (const mode of ["wired", "offline"] as const) {
  test(`reserves a known ${mode} device without requiring a Wi-Fi association`, async () => {
    const f = fixture({ [mode]: true });
    const listed = await f.client.listAddressClients();
    expect(listed[0]?.connected).toBe(mode !== "offline");
    if (mode === "offline") expect(listed[0]?.address).toBe("");
    await f.client.reserveAddress(f.mac.toUpperCase(), "10.78.0.30");
    expect(f.user.fixed_ip).toBe("10.78.0.30");
  });
}
