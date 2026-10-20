# Quiet plan review

For a substantial plan, send one independent reviewer the output of `review-packet`, the relevant repository, read access to the pinned memories, and an exact output path. Use the current available collaboration API; do not assume a model slug or spawn a fixed specialist panel.

Reviewer task:

> Review this development plan against the original user intent and current source. Work quietly: no progress messages, conversational updates or intermediate reports. You may read code, inspect graph evidence, read cited memories and run bounded read-only checks. Do not edit source, the plan or Threadnote. Write only the final JSON artifact to the provided path; your final reply should contain that artifact's path and nothing else.
>
> Check whether the current architecture is supported by actual implementation/callers; the target architecture satisfies the requested outcome; proposed components are distinguishable from existing code; material constraints from recalled memories were used with appropriate scope; every artifact directly links its relevant read-and-pinned memories; native code references point at existing code; every requirement has meaningful acceptance; and each phase boundary is independently verifiable and leaves a working product.
>
> Check implementation closeout: the plan must require verification of the as-built architecture, binding of actual current code refs including new symbols, persistence of reusable architecture, and retirement of the obsolete baseline only after replacement is verified. Consider whether the intended scope can be retired without losing still-valid architectural knowledge.
>
> Report concrete defects, with evidence and their consequence. Do not reward verbosity or invent speculative blockers. Minor routine implementation choices need not be prescribed by the plan.

Final artifact:

```json
{
  "planHash": "copy the exact packet hash",
  "verdict": "ready",
  "findings": [
    {
      "severity": "minor",
      "artifact": "target",
      "message": "Concrete issue",
      "evidence": "Source path, memory URI, or requirement/phase ID"
    }
  ]
}
```

Use `changes_requested` when critical/important findings remain; otherwise `ready`. A clear review may have an empty findings array. Material fixes invalidate the hash. Allow one targeted follow-up review for changed parts and previous blockers; do not repeat broad reviews automatically. Unresolved blockers leave a draft.
