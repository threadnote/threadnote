# Retain the existing runtime

This delivery contains decision evidence only. Runtime, tests, benchmark/workflow/release code and dependencies retain the `2d7a73c71a866a6bd86f227bef1f73831ab39b46` baseline, including already merged P1 and Bun crypto. The experimental P2 runtime/test/probe additions were removed. Archived diffs and historical receipts do not execute or ship a native payload.

| Phase                 | Decision                                                       | Evidence                                                                                                   |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P2 TypeScript vectors | DEFER experimental change; existing runtime retained           | [Vector decision and observations](../vector-typescript/README.md)                                         |
| P3 native vectors     | DEFER adoption                                                 | Separate author results commit integrates after this consolidation; no prototype/build/CI code is included |
| P4 SQL pipeline       | DEFER; no material safe redundancy identified                  | [Source inspection and fresh n=1 profiles](../sql/decision.json)                                           |
| P5 native parser      | DEFER; representative whole-worker Java evidence absent        | [Available fixture and proof gap](../parser-native/decision.json)                                          |
| P6 topology           | DEFER typed storage/native adoption; number-array DSU retained | [Counterbalanced model experiment](../topology/README.md)                                                  |

[Combined manifest](decision.json) preserves the unchanged gates and delivery boundary. No native crate, native build dependency or change to the eight-target release contract is delivered. These are justified negative adoption decisions, not invented performance failures or declarations that every pilot completed. Historical global27 activation and failed doctor/semantic-smoke observations remain limitations; the coordinator owns final runtime restoration and validation. No canonical workflow phase/run completion is claimed.
