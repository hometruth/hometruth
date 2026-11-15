# Workflows

## Turn on temporarily

Choose **Turn on temporarily** to build a timed button with a device picker,
duration, and **Leave on if already on** option. The card shows each branch before
you save. With that option enabled, pressing the button reads the device's state:
an Off device is turned On, left on for the chosen duration, and then turned Off.
An already-On device receives no commands. An unavailable state stops the run
without switching the device.

Another press during the countdown keeps the original off time. Saving the
rule does not press the button. The timer currently lives in memory: restarting
HomeTruth or reloading its configuration cancels it, so the scheduled Off action
will not run after a restart. Other controls can still change the device during
the countdown; this rule does not reserve it.

Exact timed recipes reopen as cards. **Edit individual steps** exposes their
graph, and custom graphs retain the full editor rather than losing behavior when
converted into a simpler form.

## Editing a graph

Create a Workflow Button under **Buttons**, then edit its graph. Add a step
before the selected step, connect its output dots to another step, or use the
inspector's connection selectors. **Arrange** lays out the current graph;
**Fit** brings it into view. Parallel branches and repeat bodies open as separate
graphs with breadcrumbs. The step outline supports keyboard selection and editing.

**Validate** checks the definition and its targets. **Simulate** records actions
without contacting devices and skips waits. Choose true, false, or unknown as
the assumption for every predicate; run different assumptions to inspect different
paths. Simulation stops after 500 steps and is not a prediction of hardware
success or an exhaustive analysis of every combination of decisions.

**Save workflow** writes the validated definition to the installation's
`devices.yml`. Saving does not press the button. **Press** runs the saved version,
including when an unsaved draft is visible. The run bar shows execution status;
**Cancel run** requests cancellation and cleanup.

## AI authoring

**Describe with AI** builds an authoring prompt containing your description,
the current definition, the JSON Schema, and the installation's device and operation
catalogue. Copy it to your chosen AI agent, then paste the returned JSON into
**AI workflow draft**. **Review draft on canvas** validates and imports it for
inspection. Save it separately after reviewing its branches and inputs.

This is a provider-neutral prompt/import flow; no model account is connected or
called by the editor. The prompt contains device names and IDs. It instructs the
agent to ask about unresolved targets or media rather than invent them, and never
to execute or save the workflow itself. AI drafts use the same validator as manual
edits and API writes.

## The HomeTruth format

The canonical JSON Schema is available from `/schemas/workflow`. The document
contains only behavior:

- `schemaVersion: 1`, `name`, and `description` identify the definition.
- `runPolicy` is `ignoreWhileRunning` or `replaceAfterCleanup`.
- `limits` bounds total steps and run duration in milliseconds.
- `graph` contains an `entry` node ID and `nodes`.

Each node has a stable `id`, a `type`, and an optional `label`. Transitions name
nodes in the same graph. IDs are unique within that graph. All nodes must be
reachable from its entry and have a path to an end. Cycles are permitted and are
bounded by the run limits. The whole definition is limited to 200 nodes and eight
levels of nested graphs.

| Type | Behavior and transitions |
| --- | --- |
| `action` | `{operation, target, input}`; continue through `next` or `onError`. |
| `delay` | Wait `durationMs`, then `next`. |
| `condition` | Evaluate `predicate`; choose `ifTrue`, `ifFalse`, or `onUnknown`. |
| `parallel` | Run nested `branches`; wait for all, then `next`. On failure cancel siblings, wait for cleanup, then `onError`. |
| `repeat` | Run nested `body` sequentially `count` times; then `next`, or `onError`. |
| `waitFor` | Check `predicate` every 250 ms until matched, unknown, or `timeoutMs`; choose `onMatch`, `onUnknown`, or `onTimeout`. |
| `end` | Complete this graph with `outcome: success` or `failure`. |

Targets are configured HomeTruth device IDs. Operation IDs qualify the capability
and control, such as `light.setColor` or `speaker.setVolume`. Control arguments use
`input.value`; compound operations define named inputs in the catalogue.
Unknown targets, unsupported operations, and invalid inputs are rejected before
saving. Control-specific confirmation flags cannot be embedded in a workflow;
controls that require a separate confirmation will reject an unconfirmed call.
Nested calls to other workflow buttons are not supported.

A predicate contains `target`, `path`, `operator`, and `value`. Paths are JSON
Pointers into the device document, for example
`/capabilities/light/state/on`. Operators are `equals`, `notEquals`, `greaterThan`,
and `lessThan`. Missing values, unavailable capabilities, read failures, and
incompatible numeric comparisons produce **unknown** rather than false.

## Flashing and sound

`light.flash` supports color-capable lights and groups. Its input is `colors`
(an array of hex colors), `count` (complete cycles through the colors), `onMs`,
`offMs`, and `brightnessPercent`. It snapshots each underlying light independently
and restores its reported color or temperature, brightness, and power after
completion, failure, or cancellation. Overlapping workflow actions on the same
light/group members wait until cleanup finishes. Manual controls and other
applications are outside this coordination.

`speaker.playSound` accepts `sound: dinnerBell` and `volumePercent`. Sonos adapters
advertise it when a local media service is configured. The bell is a built-in
three-second synthesized WAV. It requires a stopped, ungrouped speaker, replaces
the current playback URI, and restores volume and mute after playback or
cancellation. It does not resume earlier media or alter group membership. Hardware
playback still depends on the speaker reaching HomeTruth's LAN media endpoint.

## Storage and execution boundaries

The saved definition contains no X6 cells, coordinates, ports, styles, or execution
state. X6 renders an adapter view; it is never the serializer. ELK lays out that
view. Replacing either library does not require changing saved workflows.

Canvas positions use a separate HomeTruth `{positions: {"scope/node": {x, y}}}`
record. Positions and unfinished drafts live in this browser's local storage,
keyed by button ID. They are not shared across browsers. A changed saved base does
not silently overwrite a newer definition with an older browser draft. JSON
export contains the behavioral definition alone.

Run records are separate in-memory objects with an ID, status, active node paths,
step count, bounded trace, and timestamps. The last 20 runs are retained per
button until a reload. Execution is not durable across process restarts. The
runner checks cancellation between operations and waits for in-flight adapter
calls before cleanup; network calls rely on their adapter timeouts. Hard process
termination cannot guarantee hardware restoration.

## API

- `POST /api/buttons` creates a workflow button, optionally with a definition.
- `GET /api/buttons/:id/workflow` returns the saved definition, runs, schema, and
  caller-visible operation catalogue.
- `POST /api/buttons/:id/workflow/preview` accepts `{workflow}` for validation;
  adding `assumption: true|false|unknown` as a **string** requests simulation.
  `draft: true` checks only the shape of an unfinished browser draft.
- `PUT /api/buttons/:id/workflow` accepts `{workflow}`, validates the graph and
  target permissions, and saves it. It does not execute it.
- `POST /api/buttons/:id/press` explicitly runs the saved workflow.
- `POST /api/buttons/:id/workflow/cancel` cancels the current run.

See [the device configuration example](DEVICES.md) and the generated OpenAPI
surface for request and response contracts.
