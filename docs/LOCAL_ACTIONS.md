# Local GitHub Actions for HomeTruth

The private installation template includes
`.github/workflows/hometruth-action.yml`. It routes selected GitHub Actions
events to a GitHub self-hosted runner on a machine that can reach HomeTruth.
The job invokes the existing `ht` CLI through `bun run site`; it does not
download installation files or start the HomeTruth server.

## Set up the runner

Use a **private GitHub repository** for the installation. GitHub warns against
using self-hosted runners with public repositories because pull requests can
run untrusted workflow code on the runner machine. Restrict the runner to this
one private repository and allow only trusted contributors to change workflows
or trigger privileged events. Do not add `pull_request`, `pull_request_target`,
or other untrusted events to a workflow that runs on this machine.

1. Keep a reviewed HomeTruth source checkout and its installed dependencies on
   the local machine. Keep the private installation as a separate directory.
   The two directories must not contain one another.
2. In the private repository, open **Settings → Secrets and variables →
   Actions → Variables** and add:
   - `HOMETRUTH_SOURCE`: absolute path to the public source checkout.
   - `HOMETRUTH_INSTALLATION`: absolute path to the private local installation.
3. In **Settings → Actions → Runners**, add a repository-level self-hosted
   runner. Follow GitHub's setup steps and add the label `hometruth-local`.
   Run it as an unprivileged OS account with access only to the HomeTruth
   installation and the local network access its actions need.

Keep the runner online when an event should run. GitHub hosts the event and
workflow; the HomeTruth command runs on the machine where the runner is
connected. The job uses the private installation already present on that
machine. It does not pull newer private configuration from GitHub.

## Trigger an action

The starter workflow accepts manual `workflow_dispatch` runs and
`repository_dispatch` events with type `hometruth_action`. The manual input is
a JSON array of `ht` arguments:

```json
["find", "camera"]
```

To operate a known element, use its `ht` command and arguments, for example:

```json
["example-light", "on"]
```

For a `repository_dispatch` event, put an array in
`client_payload.arguments`. A caller with permission to dispatch events can
send a body such as:

```json
{
  "event_type": "hometruth_action",
  "client_payload": {
    "arguments": ["example-light", "on"]
  }
}
```

You can add other trusted GitHub event triggers to the workflow. For an event
without an `arguments` field, set `HOMETRUTH_ACTION_ARGUMENTS` in the run step
to a JSON array, such as `'["ls", "device", "--json"]'`. Use workflow
conditions to choose which command runs for each event. The bridge passes
arguments as an argv array; it never evaluates them as shell code.

The bridge only runs the `ht` CLI, so the command vocabulary and available
controls come from the installation's live API. Scope remains the same as the
local CLI token. HomeTruth command output is suppressed in Actions logs; logs
show the event and whether the command succeeded. Run the same command locally
through `bun run site <private-directory> ht ...` when you need its output.

## Protect the installation

A self-hosted runner can access the machine and local network. Treat every
workflow that targets it as privileged code. Keep the runner attached only to
the private installation repository, limit who can edit workflows and dispatch
events, and never route pull request code from forks or public repositories to
it. GitHub event inputs and `repository_dispatch` payloads are stored by
GitHub, so do not put credentials or other secrets in action arguments. Store
HomeTruth credentials in the installation's local secret store as usual.

See GitHub's guides for [adding self-hosted
runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners),
[using a self-hosted runner in a
workflow](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow),
and [events that trigger
workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
