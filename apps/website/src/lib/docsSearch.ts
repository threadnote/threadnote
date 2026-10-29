import {Array as EffectArray, Option as EffectOption} from 'effect';
import type {DocsArticle, DocsBlock, DocsSection} from '../content/docs.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

type SearchFieldKind = 'body' | 'code' | 'heading' | 'keywords' | 'section' | 'summary' | 'title';

interface SearchField {
  readonly kind: SearchFieldKind;
  readonly label: string;
  readonly normalized: string;
  readonly text: string;
  readonly tokens: readonly string[];
  readonly weight: number;
}

interface IndexedArticle {
  readonly article: DocsArticle;
  readonly fields: readonly SearchField[];
  readonly order: number;
  readonly section: DocsSection;
}

export interface DocsSearchIndex {
  readonly articles: readonly IndexedArticle[];
}

export interface DocsSearchResult {
  readonly article: DocsArticle;
  readonly matchLabel: string;
  readonly matchedTerms: readonly string[];
  readonly score: number;
  readonly section: DocsSection;
  readonly snippet: string;
}

const QUERY_STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'from', 'how', 'in', 'is', 'of', 'on', 'the', 'to', 'with']);

export const DOCS_SEARCH_MAXIMUM_LENGTH = 256;
export const DOCS_SEARCH_MAXIMUM_TERMS = 12;
const DOCS_SEARCH_MAXIMUM_TERM_LENGTH = 64;

const fieldWeights: Readonly<Record<SearchFieldKind, number>> = {
  body: 3,
  code: 4,
  heading: 10,
  keywords: 6,
  section: 4,
  summary: 8,
  title: 16,
};

const phraseWeights: Readonly<Record<SearchFieldKind, number>> = {
  body: 1.25,
  code: 1.25,
  heading: 2.5,
  keywords: 2,
  section: 1,
  summary: 2,
  title: 3,
};

function plainText(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replace(/\[([^\]]+)]\([^)]*\)/g, '$1'),
    EffectString.replace(/[`*_>#~|]/g, ' '),
    EffectString.replace(/\s+/g, ' '),
    EffectString.trim,
  );
}

export function normalizeDocsSearchText(value: string): string {
  return Effect.pipe(
    value,
    EffectString.normalize('NFKD'),
    EffectString.replace(/[\u0300-\u036f]/g, ''),
    EffectString.replace(/([a-z\d])([A-Z])/g, '$1 $2'),
    EffectString.toLowerCase,
    EffectString.replace(/[^a-z0-9]+/g, ' '),
    EffectString.trim,
  );
}

function tokenize(value: string): readonly string[] {
  const normalized = normalizeDocsSearchText(value);
  return normalized ? Effect.pipe(normalized, EffectString.split(' ')) : [];
}

function queryTokens(value: string): readonly string[] {
  const tokens = EffectArray.map(
    EffectArray.filter(
      tokenize(Effect.pipe(value, EffectString.slice(0, DOCS_SEARCH_MAXIMUM_LENGTH))),
      token => token.length > 1 && !QUERY_STOP_WORDS.has(token),
    ),
    token => Effect.pipe(token, EffectString.slice(0, DOCS_SEARCH_MAXIMUM_TERM_LENGTH)),
  );
  return [...new Set(tokens)].slice(0, DOCS_SEARCH_MAXIMUM_TERMS);
}

function field(kind: SearchFieldKind, label: string, value: string): SearchField {
  const text = plainText(value);
  return {
    kind,
    label,
    normalized: normalizeDocsSearchText(text),
    text,
    tokens: tokenize(text),
    weight: fieldWeights[kind],
  };
}

function blockText(block: DocsBlock): string {
  if ('text' in block) return block.text;
  if ('code' in block) return block.code;
  if ('items' in block) return EffectArray.join(block.items, ' ');
  if ('visual' in block) return Effect.pipe(block.visual, EffectString.replaceAll('-', ' '));
  return EffectArray.join([...block.headers, ...block.rows.flat()], ' ');
}

function articleFields(article: DocsArticle, section: DocsSection): readonly SearchField[] {
  const fields: SearchField[] = [
    field('title', 'Title', article.title),
    field('section', 'Section', section.title),
    field('summary', 'Summary', article.summary),
  ];
  if (article.keywords?.length)
    fields.push(field('keywords', 'Related topics', EffectArray.join(article.keywords, ' ')));

  let heading = '';
  for (const block of article.body) {
    if (block.type === 'heading') {
      heading = block.text;
      fields.push(field('heading', `Heading · ${block.text}`, block.text));
      continue;
    }
    const kind: SearchFieldKind = block.type === 'code' ? 'code' : 'body';
    fields.push(field(kind, heading ? `Under ${heading}` : 'Article content', blockText(block)));
  }
  return EffectArray.filter(fields, candidate => candidate.normalized.length > 0);
}

export function createDocsSearchIndex(sections: readonly DocsSection[]): DocsSearchIndex {
  let order = 0;
  return {
    articles: EffectArray.flatMap(sections, section =>
      EffectArray.map(section.articles, article => ({
        article,
        fields: articleFields(article, section),
        order: order++,
        section,
      })),
    ),
  };
}

function boundedEditDistance(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({length: right.length + 1}, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        (current[rightIndex - 1] ?? maximum + 1) + 1,
        (previous[rightIndex] ?? maximum + 1) + 1,
        (previous[rightIndex - 1] ?? maximum + 1) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length] ?? maximum + 1;
}

function tokenQuality(query: string, candidate: string): number {
  if (query === candidate) return 1;
  if (query.length >= 3 && Effect.pipe(candidate, EffectString.startsWith(query))) return 0.72;
  if (candidate.length >= 4 && Effect.pipe(query, EffectString.startsWith(candidate))) return 0.58;
  const maximumDistance = query.length >= 8 ? 2 : query.length >= 5 ? 1 : 0;
  if (maximumDistance > 0 && boundedEditDistance(query, candidate, maximumDistance) <= maximumDistance) return 0.4;
  return 0;
}

function bestTokenQuality(
  query: string,
  candidates: readonly string[],
  qualities: Map<string, Map<string, number>>,
): number {
  let queryQualities = qualities.get(query);
  if (queryQualities === undefined) {
    queryQualities = new Map();
    qualities.set(query, queryQualities);
  }
  let best = 0;
  for (const candidate of candidates) {
    let quality = queryQualities.get(candidate);
    if (quality === undefined) {
      quality = tokenQuality(query, candidate);
      queryQualities.set(candidate, quality);
    }
    best = Math.max(best, quality);
    if (best === 1) break;
  }
  return best;
}

function snippetAroundMatch(text: string, terms: readonly string[]): string {
  const compact = plainText(text);
  if (compact.length <= 210) return compact;
  const lower = Effect.pipe(compact, EffectString.toLowerCase);
  const matchAt = EffectArray.reduce(terms, -1, (best, term) => {
    const index = Effect.pipe(
      lower,
      EffectString.indexOf(Effect.pipe(term, EffectString.toLowerCase)),
      Effect.Option.getOrElse(() => -1),
    );
    return index >= 0 && (best < 0 || index < best) ? index : best;
  });
  const startTarget = Math.max(0, (matchAt < 0 ? 0 : matchAt) - 72);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const startBoundary = startTarget === 0 ? 0 : compact.indexOf(' ', startTarget);
  const start = startBoundary < 0 ? startTarget : startBoundary + 1;
  const endTarget = Math.min(compact.length, start + 210);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const endBoundary = endTarget === compact.length ? compact.length : compact.lastIndexOf(' ', endTarget);
  const end = endBoundary <= start ? endTarget : endBoundary;
  return `${start > 0 ? '…' : ''}${Effect.pipe(compact, EffectString.slice(start, end))}${end < compact.length ? '…' : ''}`;
}

export function searchDocs(index: DocsSearchIndex, value: string, limit = 12): readonly DocsSearchResult[] {
  const boundedValue = Effect.pipe(value, EffectString.slice(0, DOCS_SEARCH_MAXIMUM_LENGTH));
  const terms = queryTokens(boundedValue);
  if (terms.length === 0) {
    return EffectArray.map(index.articles.slice(0, Math.max(0, limit)), entry => ({
      article: entry.article,
      matchLabel: 'Recommended',
      matchedTerms: [],
      score: 0,
      section: entry.section,
      snippet: entry.article.summary,
    }));
  }

  const normalizedPhrase = normalizeDocsSearchText(boundedValue);
  const tokenQualities = new Map<string, Map<string, number>>();
  return EffectArray.map(
    EffectArray.filter(
      EffectArray.map(index.articles, entry => {
        const bestTermScores = new Map(EffectArray.map(terms, term => [term, 0]));
        let bestPhraseScore = 0;
        let bestField =
          EffectOption.getOrUndefined(EffectArray.findFirst(entry.fields, candidate => candidate.kind === 'summary')) ??
          entry.fields[0];
        let bestFieldScore = -1;
        const matchedTerms = new Set<string>();

        for (const candidate of entry.fields) {
          let candidateScore = 0;
          for (const term of terms) {
            const quality = bestTokenQuality(term, candidate.tokens, tokenQualities);
            if (quality <= 0) continue;
            matchedTerms.add(term);
            const termScore = candidate.weight * quality;
            candidateScore += termScore;
            bestTermScores.set(term, Math.max(bestTermScores.get(term) ?? 0, termScore));
          }
          if (
            normalizedPhrase.length > 2 &&
            Effect.pipe(candidate.normalized, EffectString.includes(normalizedPhrase))
          ) {
            const phraseScore = candidate.weight * phraseWeights[candidate.kind];
            candidateScore += phraseScore;
            bestPhraseScore = Math.max(bestPhraseScore, phraseScore);
          }
          if (
            candidateScore > bestFieldScore &&
            candidate.kind !== 'keywords' &&
            candidate.kind !== 'section' &&
            candidate.kind !== 'title'
          ) {
            bestField = candidate;
            bestFieldScore = candidateScore;
          }
        }

        const coverage = matchedTerms.size / terms.length;
        const minimumCoverage = terms.length === 1 ? 1 : terms.length === 2 ? 1 : 2 / 3;
        if (coverage < minimumCoverage) return undefined;
        let score =
          EffectArray.reduce([...bestTermScores.values()], 0, (total, termScore) => total + termScore) +
          bestPhraseScore;
        score *= 0.55 + coverage * 0.45;
        return {
          article: entry.article,
          matchLabel: bestField.label,
          matchedTerms: [...matchedTerms],
          order: entry.order,
          score,
          section: entry.section,
          snippet: snippetAroundMatch(bestField.text, [...matchedTerms]),
        };
      }),
      (result): result is NonNullable<typeof result> => result !== undefined,
    )
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .slice(0, Math.max(0, limit)),
    ({order: _order, ...result}) => result,
  );
}
