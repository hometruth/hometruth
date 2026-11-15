# API tokens

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

## The local network is open

By default, **anyone on a private network reaches everything without a token**:
lights, cameras, treats, event history, configuration, the network tools, this
token list. The LAN is the trust boundary. To require a token from everywhere,
set `HOMETRUTH_TRUST_LAN=off`.

"Private" means RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), loopback,
link-local, and IPv6 unique-local and link-local. It deliberately does **not**
include `100.64/10`, which is carrier-grade NAT and also Tailscale's range: a
tailnet is remote access wearing a private-looking address, and reaching the
house from outside should need a token.

The address is read off the socket by the supervisor, which deletes any inbound
copy of the header before setting it, and prefixes the value with the worker's
own secret. The worker accepts an address only when that secret is present, and
hands the app the bare address. Nothing authorizes on `X-Forwarded-For` or any
other header a client can write, and an app reached some other way — with no
trusted address at all — treats the caller as remote rather than guessing.

The secret is there for a specific reason. `bun run dev --watch` replaces
*workers*, not the supervisor, so a new worker running behind a supervisor
started hours earlier is the ordinary state after editing that file. An older
supervisor forwards client headers untouched, so a plain address header would
be forgeable for exactly as long as the skew lasted — a mismatch that failed
*open*. Binding it to a secret the caller cannot know makes it fail closed
instead: with an old supervisor in front, local-network trust simply does not
work, and everything asks for a token. See `src/auth/network.ts`,
`src/runtime/worker.ts`, and `network.test.ts`.

Two consequences worth stating plainly:

- **The token list is not the list of ways in** while this is on. The page says
  so, rather than letting the table imply otherwise.
- **A guest on your Wi-Fi is an administrator.** That is what "open on the
  local network" means. If that is not what you want, `HOMETRUTH_TRUST_LAN=off`
  and issue tokens, or put the house on its own VLAN.

## Tokens

Everything below is how access works from outside that network, and how to
narrow a particular client even inside it.

API clients present `Authorization: Bearer ht_…`. Browsers sign in with an API
token or a registered passkey and receive an independent browser session. An
access grant is the token record: its permissions and scope apply equally to
its API credential, passkeys and browser sessions. Revoking or expiring that
grant disables all three.

A route is reachable only when the token both **holds the verb** the route asks
for and **reaches the thing** the route touches. The two are independent.

**A presented token always wins over the network it arrives from.** Present a
credential and you get exactly that credential — so a Kindle carrying a
read-only token stays read-only at home, rather than quietly becoming an
administrator because of where it is standing. Only the absence of a token
falls through to local-network trust. (A *revoked* or expired cookie is the one
exception: on a trusted network it is cleared and the request continues, so a
dead cookie cannot lock you out of your own living room.)

## Permissions

| Level | What it allows within the token’s scope |
| --- | --- |
| `read` | State, listings, pictures, sound, event history and streams. |
| `write` | Read access plus normal controls: switches, PTZ, treats, IR/RF sends and talkback. |
| `admin` | Write access plus configuration and meta-actions, including enable, disable and reboot. |

The hierarchy is `read < write < admin`. Read and write grants may cover one
device, a group, criteria, or the whole site. **Admin always covers the whole
site** and requires `{ "all": true }`; scoped administrative grants are rejected,
including invalid records already present in storage. Configuration, group
membership, network reservations, enable/disable, and token management all
require site administration. Ordinary switch on/off actions need write access.

## Reach

A token's subject is written in the group builder's own vocabulary, and
resolved by the same function that decides what "All Cameras" means on the
Groups page. It is one of:

- **every device** — also the only subject that reaches site-wide routes (the
  tag ontology, the network tools, this token list);
- **one device** — `{ "device": "gate-relay" }`, covering only that device;
- **an existing group** — any group the Groups page lists, `automatic:cameras`
  included;
- **a new definition** — `room`, `schemaId` and `tagIds`, exactly as the group
  builder writes them.

Because a definition is resolved per request, a grant of `room = Kitchen` keeps
meaning the kitchen after a device moves into it, with no token to edit. A
group is all-or-nothing: one whose members are not all in reach is not listed
and cannot be commanded, because a control on a group fans out to every member.

A token scoped to part of the house cannot enumerate the rest of it. Listings
are narrowed, pages resolve through the same check, and the state stream
carries only the nodes the token reaches rather than refusing outright, so a
page stays live for the part it may see. Protected streams revalidate authority
before forwarding each chunk and at least once per second while idle. Revoking
or expiring a token/session, or changing its device scope, closes an existing
stream and cancels its upstream subscription. Data already delivered to a client
cannot be recalled.

## From the command line

```bash
ht tokens
```

```bash
ht tokens issue "Kindle dashboard" --can write --for all
```

```bash
ht tokens issue "Kitchen tablet" --can write --for room:Kitchen
```

```bash
ht tokens issue "Site administrator" --can admin --for all
ht tokens revoke <id>
```

`--can` takes `read`, `write` or `admin`.
`--for` takes `all`, `device:<id>`, `group:<id>`, or a comma-separated combination of
`room:<name>`, `schema:<id>` and `tag:<uuid>`. `--expires <date>` dates a token;
without it, it never expires.

The CLI reads its own token from `HOMETRUTH_TOKEN`, else `api.cli.token` in
`.hometruth/secrets.yml`.

## First start, and getting back in

With the local network open, nothing is minted unasked: the first start just
says so, because the console already has the run of the house and a standing
full-access credential nobody requested would be a thing to leak and nothing to
reach.

```
{"event":"local_network_open","message":"…"}
```

With `HOMETRUTH_TRUST_LAN=off`, a house with no tokens is a house nobody can
get into, so the first start mints one with admin access on every device
and prints it once:

```
{"event":"first_token_issued","kid":"…","token":"ht_…","message":"…"}
```

That is the only time a whole token is written to the log. If it scrolls past:

```bash
ht tokens bootstrap
```

That command does **not** go through the server. It opens
`.hometruth/tokens.sqlite` directly, mints a full-access token, saves it to
`api.cli.token` and prints it, so it still works when nobody can authenticate.
The file is mode 0600; anyone who can read it can already read every secret
this site holds.

Sign in with the first token, issue a dedicated grant for each person or
integration, then sign in with the appropriate grant. Register passkeys on that
grant before revoking the bootstrap token. A passkey does not survive revocation
of the grant it belongs to.

## Persistent browser sign-in

Browser sign-in requires trusted HTTPS. Loopback `http://localhost` is allowed
for development; plain HTTP on a LAN is not. Configure the proxy and its CA as
explained in [deployment](DEPLOYMENT.md#https-and-local-names). Keep the backend
on loopback, set `HOMETRUTH_TRUST_LAN=off` behind a proxy, and set
`HOMETRUTH_PUBLIC_ORIGIN` to the HTTPS origin. Each client must trust the CA.

Sign in once at `/sign-in`, then open **Sign-in & security** at
`/settings/security` to add a passkey and manage signed-in browsers. Keep the
API token in a password manager for recovery. Passkeys require a browser with
WebAuthn JSON support and an authenticator with user verification (for example,
a device unlock or security-key PIN). Enrollment and authentication require
user verification and verify the exact origin, relying-party ID and a one-use,
five-minute challenge bound to the requesting browser. Passkeys are tied to the
hostname where they were registered; choose the installation's permanent name
before enrolling them.

Each browser receives a random secret in `__Host-ht_session`, with `Secure`,
`HttpOnly`, `SameSite=Lax`, `Path=/`, no Domain and a 90-day Max-Age. Only its
SHA-256 hash is stored in the installation's `.hometruth/tokens.sqlite`.
Sessions, public passkey credentials and pending challenges survive server
restarts and release changes. Preserve this private database with installation
backups; never include it in source releases.

The server enforces both 30 days without requests and 90 days since sign-in.
Background requests count as activity. Successful sign-in replaces this
browser's previous session; a valid session visiting `/sign-in` proceeds to its
destination. Signing out revokes this browser's session on the server. The
security page lists only browsers and passkeys belonging to the caller's grant.
Removing a passkey also revokes the sessions authenticated with it.

Adding or removing passkeys, revoking browsers, and issuing or revoking API
tokens require a sign-in within the last five minutes. The UI sends an older
session to sign in again, then returns it to the page to retry the action. API
clients presenting a valid bearer token already prove their credential on every
request. LAN trust alone cannot change credentials.

Token sign-in and passkey operations are throttled to 30 requests per minute
per observed peer (shared behind a loopback proxy). Throttle memory and pending
challenge storage are bounded. No proxy-supplied client header grants trust.
Credentials in query strings do not authenticate: never put an API token in a
bookmark, QR code or URL.

## How it is built

- **`ht_<kid>_<secret>`.** `ht_` is the prefix a secret scanner matches. `kid`
  is 128 bits of public key id in hex — the store looks a token up by it, which
  makes verification one indexed read and makes a wrong token cost the same as
  a right one. `secret` is 256 bits from the CSPRNG, and the store keeps only
  `sha256(secret)`, compared in constant time. The key id is hex precisely
  because `_` is the separator and base64url contains one.
- **SHA-256, not Argon2id, and deliberately.** A memory-hard KDF exists to make
  guessing a low-entropy human password expensive. This secret is 256 uniform
  random bits: there is no dictionary. Argon2 would only add ~50 ms to every
  authenticated request, including each frame of an MJPEG stream.
- **No JWTs.** For one stateful server they buy nothing and cost revocation.
- **Default deny, by table.** `src/auth/policy.ts` maps every route to the
  permission and target it needs. A route missing from that table is denied,
  and `policy.test.ts` walks every route Hono has registered and fails the
  build if any is unlisted — including the ones that only mount conditionally.
- **Fail closed.** An app built without a token store serves 503 to everything
  rather than serving the house, unless it is running under test.

## What is not covered yet

- **No per-network narrowing.** Local-network trust is all or nothing: you
  cannot say "the LAN may control lights but not see cameras". If you want
  that, switch it off and give each client a scoped token.
- **The raw camera service.** `/api/camera/*` keys on vendor ids (cloud
  serials), not site device ids, so there is no sound way to check a scoped
  subject against it. The whole family requires a site-wide token. The modelled
  routes, `/api/cameras/:id` and `/api/devices/:id`, are the ones a narrow
  token uses.
- **The Kindle and the graph** read site-wide. `/kindle`, `/api/graph`,
  `/api/elements` and the tag pages are not narrowed, so their policy demands a
  site-wide token rather than quietly showing a scoped one too much.
