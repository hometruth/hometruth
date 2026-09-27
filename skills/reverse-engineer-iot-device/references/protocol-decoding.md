# Protocol decoding

Turn captures into a written specification in `protocol.md`, confirmed against
every packet, with decoders in `tools/` that reproduce the confirmation.

## Order of work

1. Transport: which UDP/TCP flows exist, who initiates, ports, whether there
   is a reliability layer (KCP has a recognisable 24-byte header with
   conversation ID, command byte, window, sequence, and un-acked fields).
2. Envelope: the vendor's message framing. Look for magic bytes at offset 0,
   a length field that matches the observed size minus header, a sequence
   counter that increments per message, a type/command field with few distinct
   values, and a checksum (try byte-sum, XOR, CRC16/32 over plausible ranges).
3. Payload: JSON is obvious; protobuf has varint tags; TLV has repeating
   type-length pairs; media has codec start codes (H.264 `00 00 00 01`,
   JPEG `ff d8`), and binary structs have fields that are constant across
   frames or monotonic.
4. Semantics: which command IDs and property IDs map to which app actions,
   using the wall-clock cues from the capture journal.

## Confirm, don't assume

Every framing hypothesis must hold across the entire capture, not a sample:

- Write a decoder that walks the flow and asserts the hypothesis on every
  message, printing the first violation. No violations across the observed messages supports the hypothesis, but
  does not prove it covers every message type or firmware. Investigate exceptions.
- Check both directions separately. Peers commonly use different checksums,
  different header variants, or different padding for request vs response.
- Check the first message of each flow separately. Handshakes and
  registration frames often use a variant of the framing.
- Keep the decoders. They become the fixture generators for the protocol
  unit tests.

## Investigating encryption

- Entropy per region: plaintext headers followed by high-entropy bodies mark
  the encryption boundary. Find the exact offset by looking for where
  constant fields stop being constant.
- ECB shows as repeated 8-byte (DES/3DES) or 16-byte (AES) blocks aligned to
  the boundary. Silence in audio, black in video, and zero-padded header
  fields produce repeats. Identical first block across all frames means a
  constant plaintext there.
- That constant block is a known-plaintext oracle: if you know or can guess
  the plaintext (zeros, a length field, a mu-law silence byte), test every
  candidate key in seconds with the standard cipher from Node/OpenSSL.
  Candidates, in order: constants from community projects; constants from the
  app's native libraries; per-device secrets you hold (host keys, serials,
  passwords, licence IDs) raw, hex, base64-decoded, and hashed; derivations
  found in decompilation. Record every negative result so it is never rerun.
- Byte order matters at the block level. Some native ports load the two
  32-bit halves of a DES block little-endian; verify your engine against the
  library's own tables before concluding a key is wrong.
- Chaining: identical frames diverging after the first block suggests CBC
  with a fixed IV; per-frame IV or CTR shows no repeats at all. A known
  plaintext still confirms the key for the first block under CBC with a zero
  IV.
- Padding: note whether trailing partial blocks are left clear (common in
  media paths) or padded.

## Catalogues

`protocol.md` should end up with tables for:

- Message types / command IDs: value, direction, payload shape, when seen,
  confirmed or inferred.
- Property IDs (IoT-style key/value settings): id, name from the app if
  known, type, observed values, read/write, which app screen, safety class.
  The app's static catalog is usually far larger than what this firmware
  uses; keep both and mark availability as observed.
- Constants: magic bytes, realms, keys (as hashes or by name, never the value
  if it is a credential), default ports.
- Multiplexing: logical channels or streams inside one transport and what
  each carries. Media control and media data commonly use different channels
  of the same session; missing this makes a successful control reply look
  like a media failure.

## Common pitfalls

- A successful control response proves control, not the thing controlled.
- Two properties can be coupled and must be written together.
- Some properties are served to the device at bootstrap from a config server
  rather than pushed over the command channel; changing them requires the
  device to reconnect and re-fetch.
- Firmware may accept one session at a time; overlapping requests time out
  even when each is correct. Serialize and pace.
- Session identifiers that look like constants may need to be fresh per
  session (timestamps); reusing one causes intermittent 500s.
- Timers driven by inbound traffic can starve when inbound traffic is
  continuous (media every 40 ms resetting a 120 ms timer). Look for
  "never fires" before "never sent".
