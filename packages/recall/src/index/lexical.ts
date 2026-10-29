import {Array as EffectArray} from 'effect';
import {recallDocumentTerms, type RecallCandidate, type RecallCorpusStatistics} from '../rank.js';
import {casedCodeIdentifiers} from '../identifier.js';
import {recallLexicalTerms, recallTokens} from '../tokenize.js';
import {stripFragment} from '@threadnote/platform/string-boundaries';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface RecallIndexPosting {
  readonly documentLength: number;
  readonly fieldWeight: number;
  readonly termFrequency: number;
  readonly uri: string;
}

export interface RecallQueryTermStatistics {
  readonly documentCount: number;
  readonly documentFrequency: Readonly<Record<string, number>>;
}

const MAX_QUERY_TERMS = 32;
export const POSTING_IDENTIFIER_WEIGHT = 4;
const POSTING_TITLE_WEIGHT = 3;
const POSTING_TOPIC_WEIGHT = 2;
const POSTING_WORKSPACE_SCOPE_WEIGHT = 3;
const POSTING_KEYWORD_WEIGHT = 2;
const POSTING_PROJECT_WEIGHT = 1;
const POSTING_BODY_WEIGHT = 1;
export const POSTING_BM25_SATURATION = 1.2;
export const POSTING_BM25_LENGTH_NORMALIZATION = 0.75;
const POSTING_BM25_IDF_SMOOTHING = 0.5;

export function candidatePostings(candidate: RecallCandidate): ReadonlyMap<string, RecallIndexPosting> {
  const weights = new Map<string, number>();
  const add = (value: string | readonly string[] | undefined, weight: number): void => {
    if (value === undefined) {
      return;
    }
    for (const term of new Set(indexTerms(typeof value === 'string' ? value : EffectArray.join(value, ' ')))) {
      weights.set(term, Math.max(weight, weights.get(term) ?? 0));
    }
  };
  add(candidate.text, POSTING_BODY_WEIGHT);
  add(candidate.fields?.project, POSTING_PROJECT_WEIGHT);
  add(candidate.fields?.topic, POSTING_TOPIC_WEIGHT);
  add(candidate.fields?.workspaceScope, POSTING_WORKSPACE_SCOPE_WEIGHT);
  add(candidate.fields?.keywords, POSTING_KEYWORD_WEIGHT);
  add(candidate.fields?.title, POSTING_TITLE_WEIGHT);
  add(candidate.fields?.identifiers, POSTING_IDENTIFIER_WEIGHT);
  const documentTerms = recallDocumentTerms(candidate);
  const termFrequencies = new Map<string, number>();
  for (const term of documentTerms) {
    termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
  }
  return new Map(
    EffectArray.map([...weights], ([term, fieldWeight]) => [
      term,
      {
        documentLength: documentTerms.length,
        fieldWeight,
        termFrequency: termFrequencies.get(term) ?? 1,
        uri: stripRecallAnchor(candidate.uri),
      },
    ]),
  );
}

export function postingLexicalScore(
  posting: Pick<RecallIndexPosting, 'documentLength' | 'fieldWeight' | 'termFrequency'>,
  term: string,
  corpusStatistics: RecallCorpusStatistics,
): number {
  const inverseDocumentFrequency = postingInverseDocumentFrequency(term, corpusStatistics);
  const denominator =
    posting.termFrequency +
    POSTING_BM25_SATURATION *
      (1 -
        POSTING_BM25_LENGTH_NORMALIZATION +
        POSTING_BM25_LENGTH_NORMALIZATION *
          (posting.documentLength / Math.max(1, corpusStatistics.averageDocumentLength)));
  const bm25 = inverseDocumentFrequency * ((posting.termFrequency * (POSTING_BM25_SATURATION + 1)) / denominator);
  return bm25 + posting.fieldWeight / POSTING_IDENTIFIER_WEIGHT;
}

export function postingInverseDocumentFrequency(term: string, corpusStatistics: RecallCorpusStatistics): number {
  const documentCount = Math.max(1, corpusStatistics.documentCount);
  const documentsWithTerm = ownRecordValue(corpusStatistics.documentFrequency, term) ?? 0;
  return Math.log(
    1 +
      (documentCount - documentsWithTerm + POSTING_BM25_IDF_SMOOTHING) /
        (documentsWithTerm + POSTING_BM25_IDF_SMOOTHING),
  );
}

export function selectQueryTerms(terms: readonly string[], statistics: RecallQueryTermStatistics): readonly string[] {
  const documentCount = Math.max(1, statistics.documentCount);
  return EffectArray.map(
    EffectArray.filter(
      EffectArray.map([...new Set(terms)], term => ({
        frequency: ownRecordValue(statistics.documentFrequency, term) ?? 0,
        term,
      })),
      item => item.frequency > 0,
    )
      .sort((left, right) => {
        const leftIdf = Math.log(
          1 +
            (documentCount - left.frequency + POSTING_BM25_IDF_SMOOTHING) /
              (left.frequency + POSTING_BM25_IDF_SMOOTHING),
        );
        const rightIdf = Math.log(
          1 +
            (documentCount - right.frequency + POSTING_BM25_IDF_SMOOTHING) /
              (right.frequency + POSTING_BM25_IDF_SMOOTHING),
        );
        return rightIdf - leftIdf || Effect.pipe(left.term, EffectString.localeCompare(right.term));
      })
      .slice(0, MAX_QUERY_TERMS),
    item => item.term,
  );
}

export function stripRecallAnchor(uri: string): string {
  return stripFragment(uri);
}

export function indexTerms(value: string): readonly string[] {
  return recallLexicalTerms(value);
}

export function identifiers(value: string): readonly string[] {
  const structuredIdentifiers = EffectArray.filter(
    EffectArray.map(recallTokens(value), term => recallLexicalTerms(term)[0]),
    (term): term is string => term !== undefined && /[\p{N}_.-]/u.test(term),
  );
  return [...new Set([...structuredIdentifiers, ...casedCodeIdentifiers(value)])].slice(0, 64);
}

function ownRecordValue<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return EffectRecord.has(record, key) ? record[key] : undefined;
}
