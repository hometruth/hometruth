import { expect, test } from "bun:test";
import { CLIENT_ADDRESS_HEADER, isPrivateAddress, trustsLocalNetwork } from "./network";

test("the private ranges are local", () => {
  for (const address of [
    "10.0.0.1", "10.255.255.254",
    "172.16.0.1", "172.20.5.5", "172.31.255.254",
    "10.77.0.5", "10.78.0.147",
    "127.0.0.1", "169.254.10.3",
    "::1", "fd00::1", "fc00::1", "fdff:ffff::abcd",
    // fe80::/10 runs to febf:ffff:…, so both ends of it are link-local.
    "fe80::1", "FE80::1", "febf::1", "feaf:0:0:0:0:0:0:1",
  ]) {
    expect(isPrivateAddress(address), address).toBe(true);
  }
});

test("everything else is not", () => {
  for (const address of [
    "8.8.8.8", "1.1.1.1", "203.0.113.7",
    // Just outside each range, which is where an off-by-one filter fails.
    "172.15.255.255", "172.32.0.1", "192.167.255.255", "192.169.0.1",
    "11.0.0.1", "9.255.255.255", "169.253.0.1", "128.0.0.1",
    // Just outside fe80::/10 on either side: fe00 below, fec0 above (the
    // deprecated site-local range, which is not link-local and not ULA).
    "2001:4860:4860::8888", "2001:db8::1", "fe00::1", "fe7f::1", "fec0::1", "ff02::1",
    // Carrier-grade NAT, which is also Tailscale's range: remote access, not the LAN.
    "100.64.0.1", "100.100.100.100", "100.127.255.255",
  ]) {
    expect(isPrivateAddress(address), address).toBe(false);
  }
});

test("an IPv4-mapped address is the host it maps to, and nothing else is", () => {
  expect(isPrivateAddress("::ffff:10.77.0.5")).toBe(true);
  expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  // A global address that merely ends in a dotted quad must not pass.
  expect(isPrivateAddress("2001:db8::10.77.0.5")).toBe(false);
  expect(isPrivateAddress("fe80:1234::10.77.0.5")).toBe(false);
});

test("brackets, ports and zone indices are stripped before matching", () => {
  expect(isPrivateAddress("[::1]:3000")).toBe(true);
  expect(isPrivateAddress("[fe80::1%en0]")).toBe(true);
  expect(isPrivateAddress("fe80::1%en0")).toBe(true);
  expect(isPrivateAddress("[2001:db8::1]:443")).toBe(false);
});

test("nothing, nonsense, and dressed-up nonsense are not local", () => {
  for (const address of [
    undefined, null, "", "   ", "not-an-address", "localhost",
    "192.168.1", "10.77.0.5.6", "10.77.0.256", "192.168.-1.1",
    // A leading zero reads as octal to some parsers and decimal to others.
    "010.0.0.1", "192.168.01.1",
    "10.77.0.5 ", // trailing space is fine…
  ]) {
    expect(isPrivateAddress(address), String(address)).toBe(address === "10.77.0.5 ");
  }
});

test("local-network trust is on unless it is switched off", () => {
  expect(trustsLocalNetwork({})).toBe(true);
  expect(trustsLocalNetwork({ HOMETRUTH_TRUST_LAN: "on" })).toBe(true);
  for (const value of ["off", "false", "0", "no", "OFF", " off "]) {
    expect(trustsLocalNetwork({ HOMETRUTH_TRUST_LAN: value }), value).toBe(false);
  }
});

/**
 * The supervisor spells this header out rather than importing it, so that it
 * stays free of application imports. This is what stops the two drifting: a
 * rename on one side that misses the other would silently disable LAN trust.
 */
test("the supervisor and the guard name the same header", async () => {
  const supervisor = await Bun.file(new URL("../runtime/supervisor.ts", import.meta.url)).text();
  expect(supervisor).toContain(`const CLIENT_ADDRESS_HEADER = "${CLIENT_ADDRESS_HEADER}"`);
  // And it is set from the socket, after any client copy is deleted.
  expect(supervisor).toContain("headers.delete(CLIENT_ADDRESS_HEADER)");
  expect(supervisor).toContain("server.requestIP(request)");
});

/**
 * `--watch` replaces workers but not the supervisor, so a new worker behind an
 * older supervisor is the ordinary state after editing that file — and an older
 * supervisor forwards a forged address header untouched. The address therefore
 * carries the worker's own secret, which a caller cannot know, and the worker
 * drops anything without it.
 */
test("the address the worker accepts must carry the worker secret", async () => {
  const worker = await Bun.file(new URL("../runtime/worker.ts", import.meta.url)).text();
  const supervisor = await Bun.file(new URL("../runtime/supervisor.ts", import.meta.url)).text();
  expect(supervisor).toContain("headers.set(CLIENT_ADDRESS_HEADER, `${token} ${peer}`)");
  expect(worker).toContain(`headers.delete("${CLIENT_ADDRESS_HEADER}")`);
  expect(worker).toContain("claimed.slice(0, space) === token");
});

/** The check itself, lifted out of the worker so its edges are actually tested. */
function acceptedAddress(claimed: string, token: string): string | undefined {
  const space = claimed.indexOf(" ");
  return space > 0 && claimed.slice(0, space) === token && claimed.length > space + 1
    ? claimed.slice(space + 1)
    : undefined;
}

test("only a value carrying the right secret yields an address", () => {
  expect(acceptedAddress("s3cret 10.77.0.5", "s3cret")).toBe("10.77.0.5");
  expect(acceptedAddress("s3cret ::ffff:10.77.0.5", "s3cret")).toBe("::ffff:10.77.0.5");
  for (const forged of [
    "10.77.0.5",            // no secret at all: a caller's own header
    "wrong 10.77.0.5",      // a guess
    " 10.77.0.5",           // empty secret
    "s3cret",                 // secret but no address
    "s3cret ",                // secret and an empty address
    "s3cretX 10.77.0.5",    // a prefix of the secret is not the secret
    "",
  ]) {
    expect(acceptedAddress(forged, "s3cret"), JSON.stringify(forged)).toBeUndefined();
  }
});
