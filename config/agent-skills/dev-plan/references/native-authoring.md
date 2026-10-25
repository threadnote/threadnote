# Native authoring protocol

Send one bounded JSON request on stdin to the installed `threadnote workflow-automation` command. Begin from native capabilities and request the command schema for the action needed next. Continue paged schema output only when required; do not embed the full protocol in a prompt or infer unsupported fields.

Use the same run identity and pinned skill generation to resume. The native runtime owns the durable journal, identity/profile binding, CAS, approval receipt, interrupted-write recovery, and exact readback. Do not create local shadow receipts, reuse a legacy state file, or treat a draft as approved.

Authoring actions cover scope inspection and evidence pinning, validation/rendering/review packets, confirmation, save/load/recovery/diff, spec-to-plan handoff, cycle export, and closeout input/readback. Ask the runtime for the exact schema rather than relying on this summary as a command reference.

Before pausing, persist a meaningful private draft and verify readback. On resume, continue the original operation; reconcile source or memory drift before generating a new packet. Do not delete receipts or create a new binding to bypass a recovery conflict.

Personal cloud authoring is task-local and private by default. Publication requires a concrete preview and explicit approval of that exact projection. Never publish raw planning records or claim cloud durability before verified publication.
