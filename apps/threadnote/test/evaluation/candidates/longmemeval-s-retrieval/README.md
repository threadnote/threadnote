# LongMemEval-S held-out retrieval

The candidate CLI with fusion retrieved every reference session for 376 of 450 questions within five results. Hybrid did so for 373 questions.

The evaluation did not establish the preregistered evidence for default fusion.

## Retrieval results

Each count represents questions with every reference session inside the cutoff. A partial reference set scores zero.

| Method | First five | First ten |
| --- | ---: | ---: |
| Offline · hybrid | 374/450 (83.1%) | 413/450 (91.8%) |
| Offline · SQLite BM25 | 377/450 (83.8%) | 408/450 (90.7%) |
| Offline · fusion | 382/450 (84.9%) | 414/450 (92.0%) |
| Product CLI · hybrid | 373/450 (82.9%) | 407/450 (90.4%) |
| Product CLI · candidate fusion | 376/450 (83.6%) | 413/450 (91.8%) |

## Paired comparisons

Each row compares fusion with hybrid on the same questions. The four result groups sum to the number of questions.

| Comparison | Cutoff | Both | Fusion only | Hybrid only | Neither |
| --- | ---: | ---: | ---: | ---: | ---: |
| Offline | 5 | 367 | 15 | 7 | 61 |
| Offline | 10 | 410 | 4 | 3 | 33 |
| Product CLI | 5 | 366 | 10 | 7 | 67 |
| Product CLI | 10 | 405 | 8 | 2 | 35 |

The primary criterion required more complete sets at five and a one-sided exact McNemar p-value below 0.05.
The secondary criterion required fusion to match or exceed hybrid at ten.

Offline fusion did not meet the combined criteria. The one-sided exact p-value was 0.066900253.

The product CLI default did not meet the combined criteria. The one-sided exact p-value was 0.31452942.

## Operational attempts

These counts describe retained evidence from the frozen study at export time.
Operational failures are outside the scored counts. A case recovered when a later valid receipt used the same frozen inputs.

| Comparison | Valid case receipts | Recorded unscored attempts | Recovered attempts | Unresolved attempts |
| --- | ---: | ---: | ---: | ---: |
| Offline | 450 | 0 | 0 | 0 |
| Product CLI | 450 | 1 | 1 | 0 |

The provenance file identifies affected cases and records the diagnostic categories.

A separate offline setup rehearsal stopped during temporary directory cleanup. It supplied no scored rows.

## Scope and methods

The frozen sample contains 450 answerable questions. It excludes the 20 exploratory pilot questions and the 30 abstention questions.
The benchmark measures session retrieval. Answer quality and abstention remain unmeasured.
Each question had an isolated store. Each dated conversation session supplied one memory with all user and assistant turns.
The evaluator assigned neutral IDs in chronological order and preserved the original order for timestamp ties.

IDs start at `s0001` within each question. The evaluator mapped the dataset’s `answer_session_ids` to these IDs for the reference labels.
The upstream session retriever uses user turns and applies a different reference filter. [Upstream evaluation logic](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/run_retrieval.py#L201-L211)

The offline hybrid comparison used the frozen Threadnote build and bundled BGE model. Hybrid returned up to ten sessions at the default threshold of 0.3.
SQLite FTS5 used BM25 on complete sessions with the unicode61 tokenizer. Its query matched any distinct question token.
Offline fusion combined both top-ten lists. Each occurrence contributed one divided by the sum of 60 and its one-based rank.
The evaluator sorted by descending score and then by ascending neutral session ID.

The product comparison used one executable and the same rebuilt case index for both settings.
The candidate used fusion as its default ranker. The control used `THREADNOTE_RECALL_RANKING=hybrid`.
Both CLI settings used the default threshold of 0.3 and returned up to 12 results. The evaluator scored the first five and ten.
The measured product commit was `6c629495a721b1bac1bc983a2a0a1dc2fb3e2b7a`.

## Evidence files

- [Question rankings](rankings.jsonl) contain one JSON object per question. Each object includes the gold sessions and ordered results from all five methods.
- [Summary](summary.json) contains the counts and paired outcomes for both cutoffs. The complete report also contains both decision tests.
- [Holdout protocol](holdout-protocol.json) records the selection order, excluded pilot IDs, methods, and decision criteria.
- [Product protocol](product-protocol.json) records the CLI settings and decision criteria.
- [Holdout manifest](holdout-manifest.json) identifies all 450 inputs, dataset bytes, and offline build.
- [Provenance](provenance.json) identifies the product build, model, source receipts, and SHA-256 conventions.
- [File checksums](SHA256SUMS) cover every other file in this directory.

The question IDs refer to the pinned public dataset. [LongMemEval-S dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)
