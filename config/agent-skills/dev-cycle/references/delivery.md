# Phase delivery

Each phase must leave a working product and verified acceptance. Prefer end-to-end slices; include compatibility or migration only when the actual change requires it. Record actual checks and evidence against the exact current source tree.

Before creating a PR, recall user preferences and read any PR-description style record. Apply it to the title and description.

For multiphase features in GitHub repositories, prefer stacked phase PRs: target each dependent PR at its parent branch, with the root targeting the main branch. Keep each phase reviewable and preserve delivery history when a parent merges.

When authorized, commit and open/update the phase PR, record the verified delivery receipt, and use [watch-pr]({{THREADNOTE_BUNDLE_ROOT}}/watch-pr/SKILL.md) to start or transfer the sole watch collector and leased consumer. Continue the next eligible phase immediately. When no eligible work or actionable event remains, end the model turn and leave the watch running. Resume for meaningful delivered events instead of waiting or polling for CI, draft feedback, or merge.

Check the collector, consumer, exact host target and command capability during bounded setup. Do not wait for the first notification or delivery receipt before ending the turn: delivery remains pending until a real receipt exists. Report an unsupported wake mechanism as a coverage gap and end the turn without substituting model polling. Keep existing watch identity and pending work when transferring from a periodic fallback.

Do not claim a check passed unless it ran. A watch signal is evidence to investigate, not merge authority. Follow the watch flow and preserve unresolved work across acknowledgements.
