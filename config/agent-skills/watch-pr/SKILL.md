---
name: watch-pr
description: Hand an authorized GitHub pull request to Threadnote's event-driven watcher, resolve actionable feedback, and end the model turn while idle. Use for PR monitoring or merge-when-green requests.
---

# Watch PR

Use `workflow_task_watch_pr` for the current task/watch contract and read only its registered schema/help. The installed `workflow task watch-pr` CLI action is equivalent. Start or resume the exact watch identity; inspect the current task card and returned refs. Do not invent parameters or use raw workflow-automation JSON. Preserve authority already given; repair actionable feedback by default, while merge, force-push, public comments, dismissal, and protection changes require authority.

The runtime is the sole collector. Route only to the supported owning chat and exact watch. On wake, inspect current backlog and evidence, handle actionable events, and persist each event disposition before ACK. ACK does not resolve work; retain unresolved or blocked work. If a notice supplies exact watch/consumer/wakeup/event/attempt references, use those; never infer delivery from an outbox. Inspect before same-consumer renewal: a terminal watch with no pending work needs no renewal. If the terminal status has stopped=true, pending=0, delivery=null, open=0, and blocked=0, do not renew, relay, or ACK. Otherwise route the exact event and disposition, then ACK only after persistence.

Confirm current head before changes; invalidate stale checks after head changes, investigate deterministic failures, and retry jobs only with transient-cause evidence. Green CI is not merge authority. Before an authorized merge, verify stable head, required checks, and open review threads with the supported head guard. Preserve pending work before stopping on terminal outcome or cancellation.

After bounded setup and any ready event work, leave the event-driven watch running and end the model turn. Never poll GitHub, loop on wait/relay, sleep-check, spawn model pollers, or create recurring tasks. If supported delivery cannot be armed, report the coverage gap and end the turn.
