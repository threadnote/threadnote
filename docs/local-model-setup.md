# Background local model setup

Threadnote prepares Gemma 4 (`gemma-4-e4b-it-q4`) in the background after a normal standalone installation or update. The pinned model is 4,590,807,392 bytes, approximately 4.6 GB. Setup checks available memory and disk space before downloading and verifies the complete file against its pinned SHA-256 before marking it ready. The current minimum effective memory requirement is 8 GiB; space and memory checks may defer setup on a constrained workstation.

Installing or updating Threadnote finishes independently of this download. You can use other features while setup runs. Downloading the model does not start inference, generate a draft, or apply a memory change. Generation starts only when you request it.

Automatic requests run only from the validated active standalone release. Older Manager or MCP sessions stop requesting their previous model pin after an update. An unmanaged executable or a missing/invalid active-installation pointer defers automatic setup; explicit `threadnote models setup --retry` remains available.

An existing, verified copy is reused. Interrupted transfers can resume. Only one setup worker owns a model job for a data home. Network failures use bounded retries; an eligible Manager or MCP session checks due retries once a minute, and a later session can recover interrupted work.

## Your choices stay yours

An explicit generation model or provider selection is preserved, including a provider chosen in Manager. Gemma becomes the effective local generation default only when it is ready and no generation model or provider was explicitly selected. Preparing the local model does not replace an explicit selection or modify the selection file. A previously installed model is retained even when automatic setup is turned off.

Older selection files do not distinguish an explicit disabled generation choice from an unset generation role. If you want to keep generation unconfigured, turn automatic model setup off explicitly.

## Progress and controls

Manager shows local model readiness and offers setup controls. The same controls are available through the CLI:

```sh
threadnote models setup --status
threadnote models setup --status --json
threadnote models setup --auto off
threadnote models setup --auto on
threadnote models setup --retry
```

`--auto off` persists for the selected data home and stops an active setup worker safely. `--retry` does not override that preference: use `--auto on` to re-enable setup. Explicit provider/model selections remain unchanged by either command. Use `--home /path/to/data` with these commands when managing a separate data home.

For one installation or update, skip its automatic setup request:

```sh
threadnote install --no-model-setup
threadnote update --no-model-setup
```

The shell installer forwards `--no-model-setup` to the installed binary. The PowerShell installer accepts `-NoModelSetup`. This skips that invocation; a later eligible Manager or MCP startup can still request setup. To prevent later requests too, persist `--auto off` or set `THREADNOTE_MODEL_SETUP=off` in the environment of every Threadnote process. Binary automatic-update preferences are independent of model setup preferences.

Dry runs never start setup. Automatic setup is excluded from source execution, managed development builds, test/CI processes and cloud toolsets. Developers can still explicitly request model setup with the public CLI.

## If setup needs attention

Check `threadnote models setup --status` or Manager for the current state. Free disk space or memory, restore network access, and use `--retry` when the resource problem is resolved. Permission or unreadable-state errors require restoring access to the selected data home. Automatic setup also requires a stable directory identity; if the filesystem cannot supply one, check the intended home and request setup explicitly with `--retry`. A checksum failure needs investigation before retrying; unverified bytes are never treated as ready. Unsupported runtime platforms report a reason rather than starting native inference.

An older updater may omit a custom `--home` when invoking post-update or repair. These commands do not request Gemma setup. Start the updated Manager or MCP server with the intended `--home`; its eligible startup performs catch-up in that home. A new updater passes the canonical home directly to its new-binary setup coordinator, including when repair and post-update migrations are skipped.

Uninstall stops and drains setup before erasing a data home. Queued requests are bound to the original directory identity and cannot recreate an erased home or initialize a replacement directory at the same path.

## Pilot workstations

Before beginning an RFC756 pilot, verify the installed release, selected data home, setup readiness, and the pinned model identity/hash in that workstation's receipts. A successful download or a manual inference smoke does not admit a pilot case or establish proposal quality. Preserve earlier blocked attempts; capture the human expectations and complete the pilot's evidence/admission checks before generating a proposal.
