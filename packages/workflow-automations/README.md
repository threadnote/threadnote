# Workflow automations

This private package owns native authoring, cycle, watch and closeout contracts, plus workflow scenarios. It uses the existing platform file and locking services; application composition lives in `apps/threadnote`.

Capture source and scenario measurements with Bun:

```sh
bun packages/workflow-automations/test/helpers/capture-baseline.ts \
  --repo /absolute/path/to/threadnote \
  --out /private/path/baseline.json
```

The capture records the source revision, native manifest versions, UTF-8 byte lengths of manifest-declared skill documents, and scenario IDs with their expected invariants and measurement names. Optional `--runtime /absolute/path/to/executable` adds up to three bounded `--version` startup samples and the executable byte size/hash while withholding its path.

Scenario measurement names describe planned evaluations. Token usage, pricing and quality outcomes require actual run evidence; session observations remain empty until supplied. Source measurements alone do not establish runtime correctness or platform acceptance.
