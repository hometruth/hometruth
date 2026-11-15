# Health monitoring and suggested fixes

Open `/health` to see current device and service health, suggested fixes, observed
uptime, and recent incidents. Failures appear first. Unknown health is listed
separately: an integration without physical-state feedback is not proof of an
outage. Disabled devices without outstanding action failures do not receive repair suggestions.

A failed press or switch command immediately creates a saved investigation at
`/health/investigations/{id}`. A link such as **Kitchen Lights failure** appears
indented beneath **Health** in the navigation on every page with whole-site read
access. The link is available while the investigation is still starting; opening
it shows live progress, observations, likely causes and suggested fixes. The
failure response also includes an `X-HomeTruth-Investigation` header for callers
with whole-site read access. The original error response remains an error.

Investigations run bounded, read-only health checks of the affected element and
its parent device, with at most two investigations running concurrently. They do
not retry the failed action or operate devices. Their findings use the same
evidence-based rules as the dashboard; with an Anthropic API key, Claude then
reviews the evidence (see below). A successful investigation probe alone does not clear an action failure.
Repeated failures in the same unresolved incident reuse its investigation.
Completed pages stay available after recovery; the ten most recent appear in the
navigation and dashboard. Investigations persist in the private health database,
and unfinished checks resume after a restart.

## Claude review of investigations

With an Anthropic API key, each investigation ends with a review by Claude. It
receives the failed action, the read-only observations, the rule-based
diagnosis and the element's recent events. It may look up recent events for
other elements and the list of current problems, using at most three requests.
It returns a likely cause, a confidence level and ordered proposals. Proposals
that restart, re-pair, reconfigure or operate something are marked **changes a
device**. Claude has no write access. It changes nothing; you decide what to
act on.

```sh
bun run ht secrets set vendors.anthropic.apiKey
bun run ht secrets set vendors.anthropic.monthlyBudgetUsd   # default 5
bun run ht secrets set vendors.anthropic.model              # default claude-opus-5-5
```

Restart the server after changing these settings. Without a key, investigations
use only the rules.

Spending has a hard monthly cap (UTC calendar month, default $5):

- Before each request, HomeTruth counts its exact input tokens and reserves the
  cost of those tokens plus the full 4,000-token output limit. A request is sent
  only if that reservation fits the remaining monthly budget. One investigation
  may spend at most $0.30.
- Spend is recorded from billed usage. A request with an unknown outcome, such
  as a dropped connection, is charged its full reservation. Rejected requests
  are not charged. Requests are never retried automatically.
- Only `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-4-5` have known
  prices; other models are refused. Each investigation is reviewed at most
  once, including after a restart.
- When the budget runs out, the page says so and shows only the rule-based
  findings.

The investigation page shows the review's cost and the month's spending against
the cap. The ledger is kept in the private health database.

`GET /api/health/investigations` lists recent investigations;
`GET /api/health/investigations/{id}` reads one saved investigation.
`GET /api/health/investigations/stream` sends an initial snapshot and immediate
`investigations` events containing the latest navigation entries. These routes
require whole-site read access, as does the health dashboard.

Each monitored device and service has a binary **Unreachable counts as unhealthy**
setting. Administrators can change it on an issue card or in the all-elements
table. It defaults to on. Turn it off for elements that may legitimately be
powered off: a transport failure or offline observation then displays
**Offline (allowed)** and produces no repair suggestion. The device remains
physically unavailable; HomeTruth does not pretend it is reachable or powered on.
Allowed offline time is excluded from uptime. Unknown observations and other
faults, such as invalid health answers, are not reclassified by this setting.

Failed presses, switch commands and other executed controls always produce
**Unhealthy**, even when offline periods are allowed. An action failure survives
passive readings, policy edits and server restarts until a successful action or
a subsequent healthy check confirms recovery. A check started before the failure
cannot clear it. A disabled device with an outstanding action failure also keeps
that failure visible. Settings and outstanding action failures are saved in the
installation's private health database; they survive configuration reloads and
restarts. Policy changes apply from that point onward and do not rewrite history.

Each issue includes its current observation, last-check time, incident start and
report count when available, a possible cause, and ordered next steps. Guidance
is generated automatically from health observations using deterministic rules;
it is not a model-generated diagnosis or a proven root cause. Claude reviews
appear only on investigation pages. Known parent
device failures take priority over child-device troubleshooting. Other guidance
covers pairing, credentials, host permissions, configuration, connectivity,
stale observations, and unexplained integration failures. Diagnostic text uses
English, like the underlying health observations; dashboard controls follow the
selected language.

Use **Open details** or **View log** to investigate, follow the suggested steps,
then select **Check again**. This performs the existing read-only health check
with your current access permissions. It does not restart, re-pair, reset or
operate devices. A successful healthy observation removes the active suggestion
and resolves its incident; earlier outages remain in the history and uptime.
An unsuccessful request leaves the previous observation visible.

**Investigate with your agent** provides a copyable request containing the
installation's MCP endpoint, affected element, timestamps, evidence and suggested
checks. Paste it into an agent with access to your HomeTruth installation to
obtain a deeper investigation and repair plan. This uses the existing connection
and permissions; copying does not invoke an agent or share data automatically.
The request asks the agent to separate evidence from hypotheses and obtain
approval before making changes. Review it before sharing outside your installation.

`GET /api/health/report?period=24h` (also `7d` or `30d`) includes a `diagnoses`
array alongside `entities` and `problems`. Each diagnosis identifies its entity
by `key`, includes `category`, `summary`, `likelyCause`, ordered `steps`,
`relatedKeys`, and `evidence`. Whole-installation read access is required.
Each entity includes `unreachableIsUnhealthy` and `expectedOfflineMs`. Administrators
can update the boolean with `PUT /api/devices/{address}/health/policy` or
`PUT /api/services/{address}/health/policy`, with JSON
`{"unreachableIsUnhealthy": false}`. Read-only and device-scoped grants cannot change health policies. The health status `expected_offline` denotes permitted
unavailability; `reason: "operation_failed"` identifies an outstanding failed action.
Rendering or reading the report only examines cached observations; hardware
checks remain explicit or scheduled by the monitor.
