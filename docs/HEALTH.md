# Health

`/health` shows every device and service, current health, observed uptime,
how long it has been continuously healthy, and recent problems. Current status
totals appear above the table, which lists problems first. Choose the last
24 hours, 7 days, or 30 days. Problems are grouped into incidents, with repeated
reports counted and recovery recorded. Changing symptoms stay in one ongoing
incident, showing its latest explanation; individual reports remain in the event
stream. The page updates from the existing event
stream; its periodic display refresh reads stored observations only.

The Health service checks at startup and once per hour, with at most four checks
in flight. Unhealthy or degraded devices and services are rechecked every five
minutes to confirm recovery sooner; repeated error reports do not postpone this
check. Healthy entities return to the hourly schedule. Each check has a
15-second deadline. A check that fails, throws,
times out, or returns an invalid answer cannot count as healthy. A hung handler
is not invoked again until it settles. Disabled devices and paused services are
listed but never actively checked. Replacing an instance during configuration
reload detaches the old reporter and schedules a new check.

Device operations and status reads report errors immediately. Services report
their own error events. A service error identifying a device appears against
both the service and that device. Ongoing problems emit a reminder every five
minutes without causing extra device reads. Health events are catalogued as
`health_checked` and flow through the same service/device event streams, MQTT
fan-out, and Filters as other events. Their data includes `kind`, `id`, `status`,
`detail`, `checkedAt`, and `source` (`poll`, `report`, `event`, or `repeat`).
Health reminders and Filter results are not recursively treated as new errors.

## Required device and service contract

Every `Device` and `Service` implements `checkHealth(): Promise<HealthCheck>` and
has a required `health` field in its published document. A health answer has:

```json
{
  "status": "healthy",
  "detail": "Responding normally",
  "checkedAt": "2026-01-01T12:00:00.000Z"
}
```

Statuses are `healthy`, `degraded`, `unhealthy`, `unknown`, and `disabled`.
Before the first observation, `checkedAt` is `null`. Unknown means that the
device cannot provide reliable evidence; it must not be substituted with healthy.

The base device check calls the model's required `probe()` and reads its
capabilities and sensors. Use the device's real read-only protocol, a current
hub observation, or the dependencies of a logical device. A cached identity or
successful configuration parse alone is not a physical health check. Override
`checkHealth()` when a device needs a different read-only check. For example,
the camera adapter checks its local listening ports, and a Broadlink probe
renews its protocol exchange. Individually unobservable bulbs answer unknown.

The base service check reads its required `status()`, which must reflect the
backing listener, connection, or worker. Override it for services that need an
active upstream API check. Paused services answer disabled. Implementations can
call `reportHealth({ status, detail })` as soon as they detect a failure or
confirm recovery. Use a concise, credential-free description, never a raw
exception, response body, URL containing credentials, or token.

Cached online device documents do not clear a failed active check. A successful
health check or an explicit self-report confirms recovery. Observations older
than two checking intervals become unknown.

## History and uptime

History is stored in the installation's `.hometruth/health.sqlite` and kept for
30 days. Include it in the normal private, encrypted runtime backup; do not
commit it. Device and service identifiers are separate, even when their IDs
have the same spelling.

Uptime includes earlier outages in the selected period, so a device can be
healthy now while its uptime percentage remains low. Uptime is time spent
healthy divided by observed, enabled time. Degraded and
unhealthy time count against it; unknown, disabled, and unmonitored time do not.
Each row shows how much time was actually observed. This is availability as seen
by HomeTruth, not the device's hardware boot duration. A disconnected HomeTruth
host cannot tell whether a device stayed available while it was away. Clean
shutdowns close the observation interval; after a crash, history ends at the
last 30-second monitoring heartbeat until observation resumes.

## API and access

- `GET /api/health/report?period=24h` returns the dashboard data. Periods are
  `24h`, `7d`, and `30d`.
- `GET /api/devices/:id/health` and `GET /api/services/:id/health` return the last
  observed answer without contacting hardware.
- `POST /api/devices/:id/health/check` and
  `POST /api/services/:id/health/check` request a bounded check. Send an empty
  JSON body with `Content-Type: application/json`.
- `GET /api/services/health/stream` streams health events through the existing
  service event interface. Device event streams also include their health events.

The dashboard, report, and service checks require site-wide read access. A
device-scoped read token can only read or check its permitted devices. The
existing public `/api/health` endpoint remains process liveness and exposes no
device history.
