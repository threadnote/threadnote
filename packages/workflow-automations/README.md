# Workflow automations

This private package owns native workflow automation contracts, replacement coverage, and scenario definitions. It depends on platform services; application composition may depend on this package, while workflow automations do not depend on the application. The Python helper inventory is a checklist for replacing those flows for fresh native runs. It does not define a Python compatibility, historical migration, or run-admission contract. Production code does not invoke Python.

Native implementations use the existing platform file and locking services. The package does not port legacy JSON hashing profiles or cross-language lock behavior.

Capture a reproducible source and scenario baseline with Bun:

```sh
bun packages/workflow-automations/test/helpers/capture-baseline.ts \
  --repo /absolute/path/to/threadnote \
  --out /private/path/baseline.json
```

The capture reports UTF-8 byte lengths for manifest-declared skill documents and Python files, plus frozen scenario IDs, invariants, and declared measurement names. Those names are planned measurements, not observed outcomes. Optional `--runtime /absolute/path/to/executable` records up to three bounded `--version` startup samples. Token counts, pricing, actual model usage, and quality outcomes remain unavailable unless separately measured by an appropriate evaluation system. The corpus recipe keeps routine and risk-bearing tasks, prompts, source revisions, acceptance criteria, and policy controls explicit for later comparison. Session observations remain empty unless supplied with real run evidence.

This source baseline does not establish runtime parity, concurrency safety, or native Windows acceptance. Those require separate focused evidence.
