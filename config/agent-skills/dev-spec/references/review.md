# Quiet specification review

Give an independent reviewer the `review-packet`, relevant source and read memory evidence. Ask it to judge the actual artifact, not agree with the author's conclusions. It works read-only in quiet mode and returns only its final JSON artifact:

```json
{"specHash": "hash from packet", "verdict": "ready", "findings": []}
```

For findings use `{severity: critical/important/minor, artifact, message, evidence}` and verdict `revise` for material issues. Check observable acceptance, contradictions, requirement coverage, consequential unconfirmed assumptions, relevant failure states and permissions, domain identity/invariants, contract compatibility and scope boundaries. Distinguish verified facts from proposed behavior. Check that diagrams clarify the domain without prematurely prescribing architecture, and that recalled links actually support their artifact.

The reviewer may recommend clarifications; it cannot confirm the spec on the user's behalf. Fix critical/important findings before ready. A material revision may receive one targeted follow-up. Do not add unrelated requirements or repeat review for stylistic preferences. Review is evidence of scrutiny, not proof that runtime behavior passes.
