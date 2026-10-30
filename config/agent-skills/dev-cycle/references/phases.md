# Planned phases

Use cycle actions for phase state and delivery. Read the approved plan root and only the current or dependency phase evidence. Preserve spec identity, acceptance, exclusions, delivery history, and phase review budget.

A phase is complete only when its acceptance has actual passing evidence against its current source tree and the required review is accepted. Record the verified commit/PR receipt before advancing. If source or head changes, reconcile state and rerun affected checks; old evidence does not validate new source.

After delivery, continue the next eligible phase immediately while the PR is watched. Do not wait for CI, draft feedback, or merge. A watch delivery should wake the owning chat, preserve durable disposition before ACK, and retain unresolved work after ACK.

At final closeout, validate the combined source against all approved feature criteria. Reuse a phase receipt only when it covers the same exact tree and criteria; otherwise run current combined acceptance. Closeout handles owned artifact retirement after verified knowledge readback.
