# Phase delivery

Each phase must leave a working product and verified acceptance. Prefer end-to-end slices; include compatibility or migration only when the actual change requires it. Record actual checks and evidence against the exact current source tree.

Before creating a PR, recall user preferences and read any PR-description style record. Apply it to the title and description.

For multiphase features in GitHub repositories, prefer stacked phase PRs: target each dependent PR at its parent branch, with the root targeting the main branch. Keep each phase reviewable and preserve delivery history when a parent merges.

When authorized, commit the phase changes and open or update the PR. Verify its delivery against the exact source. Use the `watch-pr` skill to select one event-driven watch for the exact PR. Preserve the existing watch identity and pending work.

If the workflow requires a canonical delivery receipt and Threadnote supports the owning host, use the workflow-bound route. Verify its workflow-bound collector, leased consumer, exact host target, and command capability. If start returns `delivery.recorded: false`, follow the exact-reference `complete` recovery in the `watch-pr` skill. Then verify the canonical delivery receipt. The first notification and host receipt can remain pending.

If the workflow requires a receipt and the workflow-bound route cannot start or record it, report the gap. Leave the phase pending. Preserve any separately authorized ordinary monitoring.

Continue the next eligible phase after you verify any required canonical delivery receipt. When you address review comments, refresh the author-owned feature memory by default. See [feature memory](feature-memory.md).

When no eligible work or actionable event remains, end the turn and leave the watch running. If no supported watch meets the requirements, report the coverage gap. Resume for delivered events. Do not substitute model polling.

Do not claim a check passed unless it ran. A watch signal is evidence to investigate, not merge authority. Follow the watch flow and preserve unresolved work across acknowledgements.
