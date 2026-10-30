# Cycle protocol

Use the installed `threadnote workflow-automation` JSON interface. Request capabilities, then only the schema for the next cycle action. The current runtime schema is authoritative; this guide does not enumerate request fields.

Resume with the original run identity and pinned generation. Workflow state owns plan binding, phase snapshots, acceptance, review, delivery receipts, CAS, and recovery. Verify readback before relying on a state change. Do not recreate state locally or bypass stale-source and identity checks.

Use cycle actions to inspect the current phase, begin and validate work, record evidence, prepare bounded packets, mark readiness, record delivery, and produce closeout evidence. Ask the runtime for exact action names and fields. A ready state requires actual evidence for the exact current tree.
