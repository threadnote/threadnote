# Development workflows

Threadnote ships `dev-spec`, `dev-plan`, `dev-cycle` and the supporting `watch-pr` skill with its release. They connect requirements, source investigation, implementation and validation to Threadnote's context and memory.

| Workflow    | Use it to                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `dev-spec`  | Define behavior, requirements and acceptance scenarios.                                                            |
| `dev-plan`  | Ground an implementation plan in current source and connect its phases.                                            |
| `dev-cycle` | Implement, review and validate the plan, then preserve verified knowledge.                                         |
| `watch-pr`  | Monitor a PR, investigate actionable failures, fix issues within the task's scope, validate and continue watching. |

Invoke a skill using your agent host's skill picker or supported invocation syntax, for example `$dev-plan` in Codex. Installation makes the workflows available; it does not run them. Small tasks can use Threadnote's core context and memory skills directly.

## Install and manage

Standard agent setup installs these workflows by default, including personal Codex and Cursor cloud bootstrap on supported platforms. Pass `--no-dev-skills` during setup to keep them disabled. Repeating setup or repairing an integration respects that choice; explicit `dev-skills install` enables them again.

```sh
threadnote dev-skills list
threadnote dev-skills install --agent codex --dry-run
threadnote dev-skills install --agent codex
threadnote dev-skills status --agent codex
threadnote dev-skills update --agent codex
threadnote dev-skills remove --agent codex
```

The mutation verbs apply immediately. Add `--dry-run` to inspect an action without changing files, or `--json` for structured results. `list` shows the supported hosts, platforms and native scopes. `status` without an agent shows recorded installations.

Use `--scope project --cwd /path/to/repository` for a host that declares project skill support. Unsupported scope or platform combinations report a reason. A recorded installation keeps its original destination even if a host environment variable later changes. Select the recorded scope and project when several installations match.

Installation uses the bundle in the current Threadnote release and works offline without a sharing team. Repeating installation for the same generation is a no-op. `threadnote update` refreshes enabled workflow installations with the new release. Use `dev-skills update` to refresh one target from the currently installed payload without downloading a separate skill release.

Restart or reload your agent host after installation or an update, then open its skill picker. A running workflow keeps its original helpers until that run finishes; reloading the host makes the new generation available for new tasks.

## Manager

Run `threadnote manage` and open **Development workflows**. Choose the host/profile and scope; project scopes require an exact registered project or an existing installation. Review the destination, installed generation, enrollment and readiness before choosing **Preview install**, **Preview update** or **Preview remove**.

The preview lists the file changes and shared consumers. Confirm that preview to apply it. Changing the target or changing files on disk invalidates the preview; inspect the new state and preview again. Canceling a preview changes no workflow files. Installation can succeed while prerequisites remain missing, and the page reports those separately.

## Readiness

Installation status and workflow readiness are separate. Planning requires Python 3.10 or newer, Git, ripgrep and the host's core Threadnote integration. PR operations also require GitHub CLI and working repository credentials. Status reports missing prerequisites; installing workflows does not silently configure MCP, hooks or agent instructions.

Configuration checks do not prove that a task's repository, publication credentials or approved content are ready. Those are checked when the workflow runs. Private local planning does not need a Git sharing team. Durable publication follows the user's sharing rules and requires the configured destination and concrete approved content.

## Personal cloud agents

Select the personal cloud profile explicitly:

```sh
threadnote dev-skills install --agent codex --profile codex-cloud-personal
threadnote dev-skills install --agent cursor --profile cursor-cloud-personal
```

Use these commands inside the corresponding supported cloud environment. Configuration readiness uses the existing personal profile; file installation does not bootstrap it. Corporate and remote-hybrid profiles are outside this workflow's support.

Personal bootstrap installs the workflows by default. A personal agent's start command maintains its existing enabled enrollment, including after an image update. Missing enrollment requires setup; start never silently re-enrolls a removed or disabled target. Run the update inside each cloud environment: updating a laptop does not update a different machine or provider image.

Cloud spec and plan drafts stay private to the task. They may be lost when an ephemeral workspace disappears. Durable closeout publishes approved, sanitized knowledge to the configured personal Git share and verifies the final graph before retiring drafts. A denied approval, unavailable credentials or failed publication keeps the drafts and reports closeout pending.

## Ownership, updates and removal

Each host target has a recorded owner and a complete copied helper generation. Shared targets list every consumer affected by an update. Existing runs retain their original helper generation; new invocations use the newly selected generation. Old generations are retained.

Manual and automatic Threadnote updates refresh recorded targets across data homes. Workflow refresh runs independently of optional local integration repair and post-update migration prompts. An edited or inaccessible target remains pending while other targets can finish. Status distinguishes the active Threadnote version from each workflow target's installed generation and last refresh result. Resolve the reported conflict and run `threadnote update` again, even when the active version is already current.

The first public release with default workflow installation also includes the refresh stage. An updater from before this feature cannot run code it does not contain. If an unpublished development installation crosses that first upgrade with both legacy post-update actions disabled, run the newly active `threadnote update` again to refresh its workflows. In a personal cloud task, the profile's start command can also restore its existing enabled enrollment.

`threadnote update --check` and `--dry-run` do not write homes, caches, locks or refresh intents. Candidate workflow compatibility remains unchecked until the verified release is available during apply. Known incompatible runtime replacements are rejected before activation; inaccessible ownership remains explicitly unverified and pending.

Edited files, extra files, symlinked paths and unowned copies are preserved and reported. Legacy manual or team-pack copies with the same skill names require an explicit migration: inspect the reported paths, move the old copies outside the host's discovery roots, then retry. Threadnote does not adopt matching files or remove team packs automatically.

Removal disables the selected enrollment. Shared entrypoints remain while another consumer uses them. Final removal deletes only unchanged owned entrypoints and preserves edited content, other skills and retained helper generations. Full Threadnote uninstall uses the same ownership rules. Interrupted operations report recovery needed and retry the recorded transaction; conflicting external changes require inspection before retry.

## Watching a PR

`watch-pr` treats actionable CI failures and review feedback as work to investigate and address. The main agent makes scoped fixes, runs focused validation, commits and pushes when authorized, then watches the new head. The polling worker only collects events. Acknowledging an event does not resolve the issue.

Explicit monitoring-only or local-only instructions remain effective. Watching does not authorize merging, force-pushing, dismissing reviews or changing branch protection. A bounded repair budget prevents endless retries. Background monitoring can wake the conversation only when the agent host provides a supported wake mechanism.
