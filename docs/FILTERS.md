# Filters and events

A **Filter** is a named set of criteria over an **Event**. Its predicate returns
true or false without changing the input. HomeTruth evaluates every saved Filter
against each new source event and emits a new `filter_matched` Event for every
match. The same criteria also select saved history and live subscriptions.

The general [Event schema](https://hometruth.ai/schemas/event) defines `at`,
`type`, `level`, `message`, optional device `subject`, and optional `data`.
Every catalogued event type has a **PayloadSchema** describing its `data`.
`GET /api/event-types` returns these as `payloadSchema`, each with its own
canonical ID under `/schemas/event-payloads/`. Recording an event validates
both the envelope and its payload. Omitting `data` is allowed only when that
type's payload has no required fields.

## Live match events

Saving a Filter activates it for incoming events; no browser needs to stay open.
Each new service or device event is tested against all saved Filters, including
Frigate `camera_object` and `camera_classified` detections, photo labels, and
motion events. Each matching Filter emits its own event, even when several
Filters match the same detection. Track updates are distinct source events;
there is no implicit cooldown or requirement that a Filter first become false.
Filter edits and deletions take effect on the next source event.

The emitted event has `type: "filter_matched"`, `level: "info"`, the source
event's device `subject` when present, and a new emission timestamp. Its payload
contains `filterId`, `filterName`, `filterRevision`, and `event`: a snapshot of
the complete original Event, including its timestamp and payload. For example:

```json
{
  "at": "2026-09-22T03:01:02.000Z",
  "type": "filter_matched",
  "level": "info",
  "subject": "camera-4",
  "message": "Filter “Night motion” matched: Motion detected",
  "data": {
    "filterId": "filter-example",
    "filterName": "Night motion",
    "filterRevision": 1,
    "event": {
      "at": "2026-09-22T03:01:01.000Z",
      "type": "motion",
      "level": "info",
      "subject": "camera-4",
      "message": "Motion detected",
      "data": { "bytes": 123 }
    }
  }
}
```

Find matches under **Services → Filter matches**, at `/services/filter-matches`.
Its history and SSE endpoints are `/api/services/filter-matches/events` and
`/api/services/filter-matches/stream`. The latest 1,000 match events are held in
memory for the current runtime. Matches also use the normal MQTT event bus at
`hometruth/events/<subject>/filter_matched` (`_site` when there is no subject).
To select matches for one Filter, use a `where` equality condition on
`/data/filterId`; the event API's `filter` parameter still applies the saved
criteria to the event being read.

`filter_matched` events never enter live evaluation, so a match-all Filter
cannot trigger a loop. Broker mirrors and history reads are not evaluated.
Startup does not replay old events into Filters. Newly published photo-label
results can describe older photos; retries of the same photo-label event are
suppressed within the runtime's most recent 10,000 photo-event identities.
Match history and this retry cache do not survive a restart; MQTT delivery uses
the existing non-retained event bus, not a durable delivery queue.

## Person seen on camera 4 between 9am and noon

This synthetic Filter selects Frigate person observations from `camera-4`,
every day from 09:00 inclusive to 12:00 exclusive in the specified timezone:

```json
{
  "schemaId": "https://hometruth.ai/schemas/filter",
  "id": "morning-person-camera-4",
  "name": "Person on camera 4 between 9am and noon",
  "condition": {
    "all": [
      { "path": "/type", "op": "eq", "value": "camera_object" },
      { "path": "/subject", "op": "eq", "value": "camera-4" },
      { "path": "/data/label", "op": "eq", "value": "person" },
      {
        "timeWindow": {
          "start": "09:00",
          "end": "12:00",
          "timeZone": "America/Los_Angeles",
          "timestamp": { "path": "/data/frameTime", "format": "unixSeconds" }
        }
      }
    ]
  }
}
```

`subject` is the configured device ID. The example uses the camera's observed
frame time, so a delayed or imported event is evaluated at the time it was seen.
Without `timestamp`, the window uses `Event.at`, the envelope timestamp. That is
normally the recording time; history importers may preserve a source time.
The Filter never guesses a timestamp's units or the zone of unzoned camera text.

## Conditions

The [Filter schema](https://hometruth.ai/schemas/filter) contains identity,
display name, optional description, and a
[Filter condition](https://hometruth.ai/schemas/filter-condition).

| Condition | Meaning |
| --- | --- |
| `all: [...]` | Every child matches. An empty array selects all events. |
| `any: [...]` | At least one child matches. |
| `not: {...}` | The child does not match. |
| `path`, `op: "eq"` or `"ne"`, `value` | Typed scalar equality or inequality. |
| `path`, `op: "in"`, `value: [...]` | The field equals one of the listed scalars. |
| `path`, `op: "contains"`, `value` | A scalar array contains this exact value. |
| `path`, `op: "gt"`, `"gte"`, `"lt"`, or `"lte"`, `value` | Numeric comparison. |
| `path`, `op: "exists"`, `value: true` or `false` | Whether the field is present; null counts as present. |
| `timeWindow: {...}` | A recurring local clock window. |
| `detectionLabels: ["person", "dog"]` | Any selected detection label in the event payload matches. |

Paths are JSON Pointers into the envelope, such as `/subject`, `/data/confidence`,
or `/data/currentZones/0`. Escape `/` as `~1` and `~` as `~0` in property names.
There are no wildcard paths. Comparisons do not coerce values: `0.9` is a number,
and `"0.9"` is a string. Missing fields do not match comparisons, including
`ne`; use `exists` to test absence. `not` negates the complete child result,
including a nonmatch caused by absence. `contains` tests array membership,
not substrings. Path comparisons use exact payload values.

`detectionLabels` reads `data.label`, `data.subLabel`, `data.classification.label`,
and `data.detections[].label`. It trims and lowercases labels, replaces underscores
with spaces, and maps `human` to `person`, `blank` to `no detection`, and
`no cv result` to `unclassified`. An empty detections array with no other label
matches `no detection`; an event without detection data does not. Multiple
selected labels mean **any**; combining this with a device selection uses **all**.
This condition operates on Events, including both video detections and photo
label events, without inspecting images or searching their display messages.

Time windows require an explicit IANA timezone and use local clock time through
daylight-saving changes. An end earlier than the start crosses midnight;
equal endpoints are rejected. During a repeated hour, both occurrences match;
a skipped hour has no matching instants. Timestamp formats are `dateTime`
(a zoned date-time string), `unixSeconds`, and `unixMilliseconds`.

Definitions are validated before use. Empty `any` groups, unknown operators,
unknown timezones, malformed paths, and invalid comparison values are rejected.
Runtime limits are 256 conditions and 16 levels. Schema validation checks shape;
runtime validation also checks timezone names, unequal window endpoints, and
complexity limits.

## Using a Filter

```ts
import { Filter } from "../src/models/filter";

const filter = new Filter(document);
const matching = filter.select(events); // preserves order and event identity
const matches = filter.matches(event);
const query = { where: filter.describe().condition };
const history = log.recent(100, query);
const unsubscribe = log.subscribe(onEvent, query);
```

Service and device event APIs accept a JSON-encoded `where` query parameter:

```ts
const parameters = new URLSearchParams({
  where: JSON.stringify(filter.describe().condition),
  limit: "100"
});
const response = await fetch(`/api/services/frigate/events?${parameters}`);
```

`where` works on `/api/events`, `/api/events/stream`,
`/api/services/:id/events`, `/api/services/:id/stream`,
`/api/devices/:id/events`, and `/api/devices/:id/events/stream`. It combines with
the existing subject, type, and label selections. Device routes always retain
their device scope. Both in-memory logs and saved camera/photo histories filter
before applying the result limit. Invalid conditions return HTTP 400 before a
stream opens. The JSON text is limited to 16,384 characters before URL encoding.

## Saving and reopening

The **Events** page (`/events`) shows every device and service event live, with
the same filters and saved Filters. Event viewers, including the Frigate camera
labels page, build a single Filter
condition from their device, event type, detection, and time selections. The device
dropdown supports checking multiple cameras; events from any checked camera
match, and **All** clears the camera restriction. The selection is stored as an
`in` predicate on `/subject`. Detection counts cover the selected cameras together.
Under **Time of day**, enable **Limit to a daily time range**, then choose
**From**, **Until**, and **Time zone**. For example, 20:00 to 08:00 selects
each night from 8pm inclusive until 8am exclusive, crossing midnight. The timezone
defaults to the browser's zone and is stored explicitly with the condition.
Disable the range to include all day. Equal endpoints and invalid zones are rejected.
New ranges use `Event.at`; an existing window's custom timestamp is preserved when
editing its times. For photo-label events, `Event.at` is the processing time;
it is not an inferred photo capture time.

Enter a name
and choose **Save as new filter**. The **Saved filters** menu reopens it;
**Update filter** replaces its definition and **Delete filter** removes the saved
definition while retaining the current selection. Other conditions, including
nested groups and additional time windows, survive changes to these controls. Expand
**Filter definition** to inspect the complete active predicate.

Saved selections use `?filter=<name-slug>` in the page URL, such as
`?filter=night-visitors`. Slugs follow the current name, normalize accents and
punctuation, and add a deterministic suffix when names collide. Renaming removes
the previous URL; there are no ID aliases or redirects. API responses include the
current `slug`. Unsaved selections use `?where=<JSON>`, with
`editing-filter=<name-slug>` when editing a saved definition; Back, Forward and
reload restore the same condition. Saved Filters
are shared across event viewers. A device page still enforces its own device scope.

| API | Request / response |
| --- | --- |
| `GET /api/filters` | `{ "filters": [{ "filter": Filter, "revision": 1, "slug": "night-visitors" }] }` |
| `POST /api/filters` | Accepts `{ "name": "…", "description": "…", "condition": … }`; description is optional. Returns the assigned Filter and revision with HTTP 201. |
| `GET /api/filters/:id` | Returns `{ "filter": Filter, "revision": 1, "slug": "night-visitors" }`. |
| `PUT /api/filters/:id` | Accepts name, optional description, condition, and the last read revision. Returns the updated Filter and revision. |
| `DELETE /api/filters/:id?revision=1` | Removes that revision; returns `{ "deleted": true }`. |

All changes require `Content-Type: application/json` (send `{}` for deletion).
Reads require site read permission, and changes require site write permission.
Stale updates/deletions return HTTP 409, missing IDs return 404, and invalid
definitions return 400. Request bodies are limited to 128 KiB.

The event history and stream APIs accept the stable `filter=<id>` (page slugs
are only for page URLs). When combined with
`where`, both conditions must match. A missing saved Filter returns 404 before
a stream opens. Existing streams use the definition resolved when they opened;
reconnect to apply a saved edit.

The runtime stores saved Filters in `.hometruth/filters.sqlite` under the private
installation directory. They survive restarts and are not written into public
source. Event, Filter, condition, and payload schemas are included in the schema
catalog, local schema pages, schema graph, and public schema build.
