---
name: install-global
description: Install this checkout's exact HEAD as the global development Threadnote binary. Use when changing runtime or product logic, after a clean commit, or when the user asks to install-global, take over the global runtime, or terminate superseded Threadnote processes.
---

# Install global development runtime

Do not install from a dirty or non-HEAD tree. Documentation-only and test-only changes skip this unless they change a packaged runtime contract.

## Procedure

1. `bun run dev:runtime-status -- --json`
2. If `checkout.dirty`, commit or restore first. The installer refuses dirty source.
3. If `install.requiresTakeOver`, resolve the owning checkout and get an explicit take-over. This machine is single-user; `--terminate-superseded` does not need a separate process-owner approval.
4. Run the suggested command, or:

```sh
bun run dev:install-global -- --terminate-superseded
# only after take-over is approved:
bun run dev:install-global -- --take-over-global-runtime --terminate-superseded
```

5. Smoke `threadnote --version` against `checkout.expectedDevelopmentVersion`. Exercise the changed CLI/MCP path and record it in the handoff.

## Success

- Installer prints the exact-HEAD version and doctor verification.
- After activation and doctor verification, the installer best-effort updates enrolled, enabled workflow targets at `update-available`. It reports every target outcome; a target update failure does not undo the active install.
- `threadnote --version` matches this HEAD.
- Cursor MCP sessions stay pinned until reconnect; CLI/new processes see the new binary.

## Failure

- Dirty/non-HEAD: fix the tree, do not bypass the installer.
- Ownership conflict without `--take-over-global-runtime`: do not invent `--force`. Ask the owning agent or the user.
- Another worktree owns the runtime: do not take over until that owner confirms, unless the user explicitly assigned this checkout.
- Ownership changed after take-over authorization: another installer won after the handoff. Confirm the current owner has finished and rerun from the start to obtain a fresh handoff.
