# LongMemEval-S retrieval with Threadnote 5.4.3

Threadnote retrieved every reference session within the first five results for **384 of 470 questions (81.7%)** with its released defaults.

| Retrieval cutoff | Questions with every reference session | Success rate |
| ---------------- | -------------------------------------: | -----------: |
| First 5          |                                384/470 |        81.7% |
| First 10         |                                416/470 |        88.5% |

A question scores one when every labeled session appears within the cutoff. A partial set or an empty result scores zero. The CLI returned an empty result for 0 eligible questions. The benchmark measures session retrieval. It did not generate or grade answers.

## Population

The run covered all 470 retrieval-eligible questions in the pinned LongMemEval-S dataset. The benchmark excludes its 30 abstention questions from retrieval metrics because they lack gold answer locations. Twenty questions also appeared in earlier development work. This full-set score includes them. [Upstream benchmark protocol](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/README.md)

## Method

1. Use the signed macOS arm64 executable from the immutable Threadnote 5.4.3 release. Verify the archive checksum. [Release assets](https://github.com/threadnote/threadnote/releases/tag/v5.4.3)
2. Use the pinned cleaned LongMemEval-S dataset. Keep user and assistant turns in each session. [Dataset revision](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)
3. Sort sessions by date and time. Preserve input order for ties. Assign neutral identifiers from `s0001` within each question.
4. Verify the stored transcripts against the source. Use a separate private home for each question.
5. Apply the released core model selection from `threadnote repair --core-only` in a clean home. The default model was `bge-small-en-v1.5-q8`.
6. Rebuild both indexes on a private copy of the verified session fixture. Verify that the active vector generation covers every session.
7. Run `threadnote recall --query="<question>"` once per scored receipt. Leave ranking, scope, result limit and relevance threshold at their defaults.
8. Map the dataset's `answer_session_ids` to neutral identifiers. Score the first five and ten sessions from the native result order.

The adapter stored the session date and complete dialogue, without answer annotations or original session IDs. Existing fixtures supplied canonical memories and reusable index data. The released executable produced every ranking in this report. [Earlier fixture description](../longmemeval-s-retrieval/README.md)

The upstream script indexes only user turns. It excludes reference sessions when no user turn has an answer label. These differences affect comparisons with published scores. [Upstream retrieval code](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/run_retrieval.py#L188-L195)

The driver retried recall after a synchronization warning on 8 attempts. Each question contributed once.

## Comparison with Threadnote 5.4.4

Both released executables used their defaults on the same 470 questions. Each pair had identical transcripts, references and bundled embedding model. Each release rebuilt its own indexes. A gain means only 5.4.4 retrieved every reference session. A loss means only 5.4.3 did.

| Cutoff   |           5.4.3 |           5.4.4 | Net change in questions | Gains | Losses |
| -------- | --------------: | --------------: | ----------------------: | ----: | -----: |
| First 5  | 384/470 (81.7%) | 397/470 (84.5%) |                     +13 |    16 |      3 |
| First 10 | 416/470 (88.5%) | 420/470 (89.4%) |                      +4 |     4 |      0 |

The summary includes exact two-sided McNemar tests for each cutoff. The 20 earlier development questions also contribute to these comparisons. [Published 5.4.4 results](../longmemeval-s-default-v5.4.4/README.md)

## Evidence

The [rankings](rankings.jsonl) contain the references and ordered results for each question. The [summary](summary.json) contains exact totals. The [provenance](provenance.json) identifies the dataset, archive, executable and model. The [checksums](SHA256SUMS) cover all four files.
