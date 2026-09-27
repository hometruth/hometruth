# Tactacam REVEAL cloud photos

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth's `tactacam-reveal` model reads JPEGs already uploaded to the REVEAL
cloud. It needs the same account email and password as the official app, an
active account with access to the camera's photos, and internet access from
the HomeTruth server. No LAN address is required for a cellular camera.

The snapshot is the latest photo in the cloud feed, not a newly triggered
exposure. Its age depends on the camera's motion and upload settings. The
adapter does not request HD media, trigger an exposure, alter settings,
delete photos, or purchase anything. It does not provide live video.

## Setup

Bun loads `.env.local` when the server or CLI starts. The adapter reads
`REVEAL_TATACAM_USER` and `REVEAL_TATACAM_PASSWORD` from that environment.
The corrected spelling `REVEAL_TACTACAM_USER` / `REVEAL_TACTACAM_PASSWORD`
is also supported and takes precedence if either corrected key is present.
Keep each account pair together; incomplete pairs are not mixed with another
source. These variables apply to every REVEAL camera without explicit device
credentials. The adapter never writes `.env.local`.
Restart an already-running server after changing environment credentials;
the YAML device inventory itself reloads automatically.

With these variables set, list the account's cameras directly:

```sh
bun run reveal cameras
```

Alternatively, store a device-specific account using the prompts. Device
credentials take precedence over the environment. Do not put credentials in
YAML device config or shell arguments. `trail-camera` is an example
HomeTruth instance ID you choose.

```sh
bun run ht secrets set devices.trail-camera.email
bun run ht secrets set devices.trail-camera.password
bun run reveal cameras --device trail-camera
```

Copy the desired `cameraId` from that list into `devices.yml`:

```yaml
  - id: trail-camera
    name: Trail camera
    model: tactacam-reveal
    config:
      cameraId: REPLACE_WITH_REVEAL_CAMERA_ID
      pollIntervalMs: 300000
```

The camera page displays a persistent photo gallery. The standard
`GET /api/cameras/trail-camera/snapshot` route returns its JPEG bytes;
`bun run ht trail-camera latest-photo` returns the latest photo ID,
camera ID, and vendor timestamps, without the signed download URL. A missing
timestamp stays absent; `photoTimestamp` is the vendor's camera time and is
not assumed to be UTC. `createdTimestamp`, when present, is the vendor's
upload timestamp in milliseconds.

The snapshot endpoint also supports on-demand reads cached for five minutes
by default (minimum one minute). Its JPEG stays cached in memory until the
latest photo ID changes. `online`
means the cloud feed responded; it does not prove the cellular camera is
awake. An empty accessible feed reports no snapshot available. Login errors
report degraded availability; the snapshot route explains the error.

## Automatic photo series

While the HomeTruth server is running, every configured REVEAL camera polls
the cloud automatically, even with no browser open. `pollIntervalMs` controls
the delay after a successful sync; the default is five minutes, plus at most
ten seconds for the local scheduler when idle. This checks photos already in
the cloud; it does not wake the cellular camera or request a new exposure.
After failures the interval grows up to an hour (or the configured interval
if longer). The gallery shows the last successful sync, next check, and any
error, and continues serving saved photos during a cloud outage.

The first sync imports existing photos. Later syncs save unseen IDs and stop
at a fully saved page. A full scan once a day catches older or delayed entries.
There is no total page limit. `archiveMaxPages` controls the batch size
(default 100 pages of up to 100 photos; configurable up to 10000). Larger
archives continue in another batch after ten seconds. Each completed page
saves its continuation point, so imports resume after failures or server
restarts without skipping a partially downloaded page. Rejected or expired
continuation tokens restart traversal after backoff, keeping saved JPEGs.
**Fetch all photos** queues another complete traversal, including older
entries. It respects any active error backoff. “All” means every photo still
available to the account on REVEAL, not deleted photos or SD-card-only images.

The archive lives in `.hometruth/reveal/library/`: original downloaded JPEGs
plus a SQLite timestamp index. Files have owner-only permissions, images
commit atomically before their index entries, and credentials/signed image
URLs are never written to the index. It survives server restarts. There is
no automatic deletion or retention limit; back up this directory with the
rest of your HomeTruth data. Run one HomeTruth server per archive directory.

The gallery orders photos by upload time, shows the camera's capture time
without guessing a timezone, and offers older pages and JPEG downloads:

- `GET /api/cameras/<device-id>/photos` returns saved metadata and sync status.
- Pass its opaque `nextCursor` as `?cursor=...` to get older photos.
- Pass `?order=oldest` to traverse forwards; keep the same order with each cursor.
- `GET /api/cameras/<device-id>/photos/<photo-id>` returns the saved JPEG.
- `POST /api/cameras/<device-id>/photos/sync` with JSON `{}` queues a full import.

Gallery requests only read local data; Refresh does not bypass cloud polling.
The browser refreshes the first gallery page every 30 seconds while visible;
after opening older pages, use Refresh to return to the latest list.

**Play all** plays the local archive from oldest upload to newest. Pause,
Resume, Stop, and seconds-per-photo controls are beside the viewer. Playback
loads one metadata page and one photo at a time, so it does not require the
whole archive in browser memory. The displayed capture time remains the
camera's original time; upload order can differ from capture order. Playback
finishes when it reaches the end; new photos remain available in the gallery.

### Polling versus subscription

This adapter polls `photos/v2` with HTTP queries. It does not implement a
new-photo webhook or subscription.
Tactacam documents [mobile app notifications](https://tactacam.zendesk.com/hc/en-us/articles/39545915776027-Turning-on-off-notifications-for-REVEAL-app),
but email/SMS alerts explicitly exclude new photos. App notifications are
not a supported integration hook for this adapter, so it uses polling.

## Wildlife labels on the Frigate host

HomeTruth can send each saved JPEG over configured SSH transport to an isolated
SpeciesNet worker on a user-selected host, optionally alongside Frigate. This is a HomeTruth extension,
not a stock Frigate JPEG-labeling API. It creates no recordings or Frigate
video events. The [SpeciesNet camera-trap model](https://github.com/google/cameratrapai)
provides wildlife species as well as animal/person/vehicle detections.

The worker uses SpeciesNet package 5.0.5, model 4.0.3a. Each result retains
its model fingerprint, image SHA-256, analysis time, normalized detection
boxes, prediction confidence and alternative species. Species predictions
describe the dominant animal in a photo, not every individual in a mixed
scene. Confidence is a model score, not a guarantee. Predictions below 80%
or labeled unknown/animal are displayed as uncertain. “No animal, person or
vehicle detected” does not prove the image contains none. This adapter does not apply geographic filtering.

Labels live in the same SQLite archive as the photos. Missing results form
a persistent queue: old photos are backfilled, new arrivals take priority,
and completed results survive restarts. Failed work retries with backoff;
processing stays serial and independent of cloud polling. The gallery shows
labels, confidence and progress. HomeTruth must be running to send new jobs.

All completed results also appear on HomeTruth's **Frigate camera labels**
page at `/services/frigate`. Select the REVEAL camera to see its thumbnails,
species labels and **View photo** links; **Load older labels** traverses the
full labeled archive. New results arrive live. This combined HomeTruth view
reads the existing archive directly, without duplicating JPEGs, limiting
photo retention, or republishing old results as new alerts on restart.
When the optional photo importer is configured, the native Frigate **Explore**
gallery also receives the original stills and
their labels through an independent durable import queue. This saves JPEG
snapshots and thumbnails on the Frigate host, with no generated or duplicate
video. It backfills all saved photos and imports future results automatically.
HomeTruth's Detection type checkboxes filter by person, animal or species,
across saved history and new events. See [Frigate integration](FRIGATE.md#native-frigate-photo-gallery)
for the version-pinned importer, retention, time semantics and recovery steps.

The reference worker is in `src/vendors/frigate/stills/`. Build its Docker
image on the chosen worker host, then start it without network access or published
ports. Downloading the public model happens during the build; inference uses
local weights. The container does not mount Frigate config or media and does
not modify the live-camera installation:

```sh
docker build -t hometruth-stills:speciesnet-5.0.5 src/vendors/frigate/stills
docker run -d --name hometruth-photo-labeler --restart unless-stopped \
  --network none --cpus 2 --memory 4g --pids-limit 256 \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m,mode=1777 \
  hometruth-stills:speciesnet-5.0.5
```

Configure `vendors.frigateStills` in the private HomeTruth secrets file with
`enabled: true`, an absolute `sshConfigPath`, `sshHost` (the verified SSH alias),
and `container: hometruth-photo-labeler`. The alias needs noninteractive
permission to run `sudo -n docker exec` on that host. Restart HomeTruth after
changing these settings. SSH uses its saved identity and host-key checks;
no account password is passed in arguments. Images are temporary in worker
memory/tmpfs and are deleted after inference. Full results remain in HomeTruth.

To pause labeling, set `enabled: false` and restart HomeTruth. Keep the archive
directory to preserve both downloaded photos and labels. Updating a model
does not silently replace existing labels; explicit reprocessing would need
to be added separately.

## Download photos to disk

When using `.env.local` credentials, `--device` can be omitted.

```sh
bun run reveal download \
  --device trail-camera \
  --camera-id REPLACE_WITH_REVEAL_CAMERA_ID \
  --output ./reveal-photos --all
```

This traverses the camera's feed and downloads its existing JPEGs. Run it
again to pick up new photos; existing files are skipped. Filenames are stable
SHA-256 hashes of the camera ID and photo ID, so upstream IDs cannot become
filesystem paths. Files are written atomically with owner-only permissions;
no tokens, signed URLs, or account passwords are saved alongside them. Use
one downloader per output directory. This command is a one-time download,
not a background scheduler.

`--all` traverses until the remote feed ends. Without it, the default safety
limit is 100 pages of up to 100 photos; `--max-pages` accepts up to 10000.
Reaching that explicit bound reports an error rather than claiming completion.
The CLI traverses existing pages on a repeat run, but skips saved images.
A failed download can be retried without leaving a partial JPEG marked as
complete. The server archive additionally saves page checkpoints.

## Protocol and verification

This is an unofficial adapter derived from the publicly served
[REVEAL web app](https://account.revealcellcam.com/)
bundle `assets/index-CQDt0Fhq.js` (web version 5.10.0). These are observed
client request shapes, not a published or guaranteed third-party API:

| Operation | Observed web-client contract |
| --- | --- |
| Login | Cognito `InitiateAuth`, `USER_PASSWORD_AUTH`, region `us-east-1`, public web client ID `6r9tpojvgvkci5trla0ip14mon` |
| Refresh | Cognito `REFRESH_TOKEN_AUTH`; session tokens are kept only in memory |
| API headers | `Authorization: Bearer <access token>`, `Reveal-User-Agent: RevealWeb/5.10.0` |
| Cameras | `GET https://api.reveal.ishareit.net/v1/cameras`, `response.cameras` |
| Photo feed | `GET /v1/photos/v2?cameraIds=<id>&size=100`; `response.photos`, `response.nextToken` passed back as `paginationKey` |
| Photo details | `GET /v1/photos/<photoId>`, `response.photo`; used once to renew an expired image URL |
| Image | Unauthenticated GET of `photoUrl`; no account headers sent to storage |

The adapter rejects unexpected response shapes, repeating page tokens,
cross-camera results, redirects, non-JPEG content, and images over 20 MiB.
HTTPS download hosts are restricted to Tactacam/REVEAL/ishareit domains and
Amazon S3/CloudFront domains. A newly introduced CDN may need to be added
after verification. LAN media URL restrictions elsewhere in HomeTruth remain
in effect; the vendor downloads the bytes through its own media callback.

The adapter implements authenticated login, camera and photo listing, JPEG
download, and a HomeTruth snapshot route. Compatibility depends on the cloud
API and account region; this is not a general local REVEAL camera API. Credential environment aliases
and source precedence are covered by unit tests. Session expiry, pagination
edge cases, and expired signed-link renewal remain covered by synthetic
fixtures rather than live failure captures. MFA and other interactive
Cognito challenges are reported explicitly and are not implemented. The
endpoint configuration is the official North American production environment
observed in the web bundle.

Tactacam documents cloud photo management in
[Managing Your Photos](https://tactacam.zendesk.com/hc/en-us/articles/42685209875867-Managing-Your-Photos-in-the-REVEAL-App)
and explains that additional HD requests can incur charges in
[Requesting HD Images](https://tactacam.zendesk.com/hc/en-us/articles/37073865556763-Requesting-HD-Images-for-Your-REVEAL-Cellular-Trail-Camera).
