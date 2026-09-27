import { describe, expect, test } from "bun:test";
import {
  meariPeerCandidates,
  selectMeariPeerCandidate,
} from "./local-peer-client.ts";

describe("Meari local peer client", () => {
  test("merges and deduplicates camera SDP and top-level candidates", () => {
    expect(meariPeerCandidates({
      sdp: [
        "a=ice-ufrag:camera",
        "a=ice-pwd:password",
        "m=audio 42000 RTP / AVP 0",
        "c=IN IP4 10.78.0.77",
        "a=candidate:Hc0a8044d 1 UDP 1694498815 10.78.0.77 42000 typ host",
        "",
      ].join("\n"),
      candidate: { ip: "10.78.0.77", port: 42000, type: "host" },
    })).toEqual([{ ip: "10.78.0.77", port: 42000, type: "host" }]);
  });

  test("prefers the authorized direct camera candidate", () => {
    const candidates = [
      { ip: "203.0.113.5", port: 9100, type: "relay" },
      { ip: "10.78.0.88", port: 44000, type: "host" },
      { ip: "10.78.0.77", port: 45000, type: "host" },
    ];
    expect(selectMeariPeerCandidate(candidates, "10.78.0.77")).toEqual(candidates[2]);
  });

  test("prefers the exact local relay when requested", () => {
    const candidates = [
      { ip: "10.78.0.77", port: 45_000, type: "host" },
      { ip: "10.78.0.10", port: 9_100, type: "relay" },
    ];
    expect(selectMeariPeerCandidate(
      candidates,
      "10.78.0.77",
      { ip: "10.78.0.10", port: 9_100 },
    )).toEqual(candidates[1]);
  });
});
