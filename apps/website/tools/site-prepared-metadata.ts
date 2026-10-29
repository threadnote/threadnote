import {Array as EffectArray} from 'effect';
import {ScriptError} from './effect/errors.js';
import {loadWebsiteArticles} from './site-articles.js';
import {loadRetainedPerformanceEvidence, performanceArtifactRelativePath} from './site-performance-evidence.js';
import {loadLatestMajorWebsiteReleases, type WebsiteRelease} from './site-release-notes.js';
import {assertRetainedPerformanceArtifact, type PerformanceEvidence} from '@threadnote/evidence/performance';
import {isJsonObject} from '@threadnote/platform/json';
import type {WebsiteArticle} from '../src/content/websiteArticles.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const preparedWebsiteMetadataSchemaVersion = 1;
export const preparedWebsiteMetadataEnvironment = 'THREADNOTE_SITE_PREPARED_METADATA';
export type WebsiteReleaseMode = 'local' | 'public';

export interface PreparedWebsiteMetadata {
  readonly schemaVersion: typeof preparedWebsiteMetadataSchemaVersion;
  readonly siteBase: string;
  readonly releaseMode: WebsiteReleaseMode;
  readonly articles: readonly WebsiteArticle[];
  readonly releases: readonly WebsiteRelease[];
  readonly performanceEvidence: PerformanceEvidence;
  readonly performanceArtifactText: string | null;
}

function exactRecord(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isJsonObject(value)) throw ScriptError.make({message: `Prepared website metadata ${path} must be an object.`});
  const record = value;
  const actual = EffectRecord.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || EffectArray.some(actual, (key, index) => key !== expected[index])) {
    throw ScriptError.make({message: `Prepared website metadata ${path} has unexpected or missing fields.`});
  }
  return record;
}

function boundedRecord(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isJsonObject(value)) throw ScriptError.make({message: `Prepared website metadata ${path} must be an object.`});
  const record = value;
  if (EffectArray.some(EffectRecord.keys(record), key => !keys.includes(key))) {
    throw ScriptError.make({message: `Prepared website metadata ${path} has an unexpected field.`});
  }
  return record;
}

function assertSiteBase(siteBase: string): void {
  const segments = EffectArray.filter(Effect.pipe(siteBase, EffectString.split('/')), Boolean);
  if (
    !Effect.pipe(siteBase, EffectString.startsWith('/')) ||
    !Effect.pipe(siteBase, EffectString.endsWith('/')) ||
    Effect.pipe(siteBase, EffectString.includes('//')) ||
    EffectArray.some(segments, segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))
  ) {
    throw ScriptError.make({
      message: 'Prepared website metadata siteBase must be a root-relative directory path ending in /.',
    });
  }
}

function assertStringArray(value: unknown, path: string): asserts value is readonly string[] {
  if (!EffectArray.isArray(value) || EffectArray.some(value, entry => typeof entry !== 'string')) {
    throw ScriptError.make({message: `Prepared website metadata ${path} must be a string array.`});
  }
}

function assertArticles(value: unknown): asserts value is readonly WebsiteArticle[] {
  if (!EffectArray.isArray(value))
    throw ScriptError.make({message: 'Prepared website metadata articles must be an array.'});
  for (const [index, entry] of value.entries()) {
    const article = boundedRecord(entry, `articles[${index}]`, [
      'author',
      'authorUrl',
      'body',
      'highlights',
      'kind',
      'publishedAt',
      'slug',
      'socialImage',
      'socialImageAlt',
      'summary',
      'title',
    ]);
    if (article.kind !== 'article')
      throw ScriptError.make({message: `Prepared website metadata articles[${index}].kind is invalid.`});
    for (const key of ['author', 'body', 'publishedAt', 'slug', 'summary', 'title'] as const) {
      if (typeof article[key] !== 'string')
        throw ScriptError.make({message: `Prepared website metadata articles[${index}].${key} must be a string.`});
    }
    assertStringArray(article.highlights, `articles[${index}].highlights`);
    for (const key of ['authorUrl', 'socialImage', 'socialImageAlt'] as const) {
      if (article[key] !== undefined && typeof article[key] !== 'string') {
        throw ScriptError.make({
          message: `Prepared website metadata articles[${index}].${key} must be a string when present.`,
        });
      }
    }
  }
}

function assertReleases(value: unknown): asserts value is readonly WebsiteRelease[] {
  if (!EffectArray.isArray(value))
    throw ScriptError.make({message: 'Prepared website metadata releases must be an array.'});
  for (const [index, entry] of value.entries()) {
    const release = exactRecord(entry, `releases[${index}]`, [
      'body',
      'headline',
      'highlights',
      'major',
      'minor',
      'patch',
      'publishedAt',
      'releaseUrl',
      'socialImage',
      'socialImageAlt',
      'summary',
      'version',
    ]);
    for (const key of [
      'body',
      'headline',
      'publishedAt',
      'releaseUrl',
      'socialImage',
      'socialImageAlt',
      'summary',
      'version',
    ] as const) {
      if (typeof release[key] !== 'string')
        throw ScriptError.make({message: `Prepared website metadata releases[${index}].${key} must be a string.`});
    }
    for (const key of ['major', 'minor', 'patch'] as const) {
      if (typeof release[key] !== 'number' || !Number.isSafeInteger(release[key]))
        throw ScriptError.make({message: `Prepared website metadata releases[${index}].${key} must be an integer.`});
    }
    assertStringArray(release.highlights, `releases[${index}].highlights`);
  }
}

export function websiteReleaseModeFromEnvironment(): WebsiteReleaseMode {
  return process.env.THREADNOTE_SITE_PUBLIC_BUILD === '1' ? 'public' : 'local';
}

export function parsePreparedWebsiteMetadata(value: unknown): PreparedWebsiteMetadata {
  const record = exactRecord(value, 'root', [
    'schemaVersion',
    'siteBase',
    'releaseMode',
    'articles',
    'releases',
    'performanceEvidence',
    'performanceArtifactText',
  ]);
  if (record.schemaVersion !== preparedWebsiteMetadataSchemaVersion) {
    throw ScriptError.make({
      message: `Prepared website metadata schemaVersion must be ${preparedWebsiteMetadataSchemaVersion}.`,
    });
  }
  if (typeof record.siteBase !== 'string')
    throw ScriptError.make({message: 'Prepared website metadata siteBase must be a string.'});
  assertSiteBase(record.siteBase);
  if (record.releaseMode !== 'local' && record.releaseMode !== 'public') {
    throw ScriptError.make({message: 'Prepared website metadata releaseMode must be local or public.'});
  }
  if (!EffectArray.isArray(record.articles) || !EffectArray.isArray(record.releases)) {
    throw ScriptError.make({message: 'Prepared website metadata articles and releases must be arrays.'});
  }
  assertArticles(record.articles);
  assertReleases(record.releases);
  const rawPerformanceEvidence = record.performanceEvidence;
  if (!isJsonObject(rawPerformanceEvidence))
    throw ScriptError.make({message: 'Prepared website metadata performance evidence must be an object.'});
  const performanceState = rawPerformanceEvidence.state;
  let validatedPerformanceEvidence: PerformanceEvidence;
  if (performanceState === 'pending') {
    const reason = rawPerformanceEvidence.reason;
    if (typeof reason !== 'string')
      throw ScriptError.make({message: 'Prepared website metadata pending performance evidence needs a reason.'});
    validatedPerformanceEvidence = {state: 'pending', reason};
  } else if (performanceState === 'verified') {
    const artifact = rawPerformanceEvidence.artifact;
    try {
      assertRetainedPerformanceArtifact(artifact);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown validation error';
      throw ScriptError.make({
        message: `Prepared website metadata verified performance evidence is invalid: ${reason}`,
      });
    }
    validatedPerformanceEvidence = {state: 'verified', artifact};
  } else {
    throw ScriptError.make({message: 'Prepared website metadata performance evidence state is invalid.'});
  }
  if (record.performanceArtifactText !== null && typeof record.performanceArtifactText !== 'string') {
    throw ScriptError.make({message: 'Prepared website metadata performanceArtifactText must be a string or null.'});
  }
  if (validatedPerformanceEvidence.state === 'verified' && !record.performanceArtifactText) {
    throw ScriptError.make({
      message: 'Prepared website metadata verified performance evidence needs its artifact text.',
    });
  }
  if (validatedPerformanceEvidence.state === 'pending' && record.performanceArtifactText !== null) {
    throw ScriptError.make({
      message: 'Prepared website metadata pending performance evidence cannot include artifact text.',
    });
  }
  return {
    schemaVersion: preparedWebsiteMetadataSchemaVersion,
    siteBase: record.siteBase,
    releaseMode: record.releaseMode,
    articles: record.articles,
    releases: record.releases,
    performanceEvidence: validatedPerformanceEvidence,
    performanceArtifactText: record.performanceArtifactText,
  };
}

export async function prepareWebsiteMetadata(input: {
  readonly repositoryRoot: string;
  readonly siteBase: string;
  readonly releaseMode: WebsiteReleaseMode;
}): Promise<PreparedWebsiteMetadata> {
  assertSiteBase(input.siteBase);
  const [articles, releases, performanceEvidence] = await Promise.all([
    loadWebsiteArticles(input.repositoryRoot),
    Promise.resolve(loadLatestMajorWebsiteReleases(input.repositoryRoot)),
    loadRetainedPerformanceEvidence(input.repositoryRoot, input.siteBase),
  ]);
  const performanceArtifactText =
    performanceEvidence.state === 'verified'
      ? await Bun.file(`${input.repositoryRoot}/${performanceArtifactRelativePath}`).text()
      : null;
  return {
    schemaVersion: 1,
    siteBase: input.siteBase,
    releaseMode: input.releaseMode,
    articles,
    releases: EffectArray.map(releases, release => ({
      body: release.body,
      headline: release.headline,
      highlights: release.highlights,
      major: release.major,
      minor: release.minor,
      patch: release.patch,
      publishedAt: release.publishedAt,
      releaseUrl: release.releaseUrl,
      socialImage: release.socialImage,
      socialImageAlt: release.socialImageAlt,
      summary: release.summary,
      version: release.version,
    })),
    performanceEvidence,
    performanceArtifactText,
  };
}

export async function writePreparedWebsiteMetadata(
  outputPath: string,
  metadata: PreparedWebsiteMetadata,
): Promise<void> {
  await Bun.write(outputPath, `${JSON.stringify(metadata)}\n`);
}

export async function loadPreparedWebsiteMetadata(input: {
  readonly metadataPath: string;
  readonly siteBase: string;
  readonly releaseMode: WebsiteReleaseMode;
}): Promise<PreparedWebsiteMetadata> {
  assertSiteBase(input.siteBase);
  const file = Bun.file(input.metadataPath);
  if (!(await file.exists()))
    throw ScriptError.make({message: `Prepared website metadata does not exist: ${input.metadataPath}`});
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw ScriptError.make({message: 'Prepared website metadata is not valid JSON.'});
  }
  const metadata = parsePreparedWebsiteMetadata(value);
  if (metadata.siteBase !== input.siteBase || metadata.releaseMode !== input.releaseMode) {
    throw ScriptError.make({message: 'Prepared website metadata does not match this site base and release mode.'});
  }
  return metadata;
}

export async function loadPreparedWebsiteMetadataFromEnvironment(
  siteBase: string,
): Promise<PreparedWebsiteMetadata | undefined> {
  const metadataPath = process.env[preparedWebsiteMetadataEnvironment];
  if (!metadataPath) return undefined;
  return loadPreparedWebsiteMetadata({metadataPath, siteBase, releaseMode: websiteReleaseModeFromEnvironment()});
}

if (import.meta.main) {
  const outputFlag = Bun.argv.indexOf('--output');
  const outputPath = outputFlag === -1 ? undefined : Bun.argv[outputFlag + 1];
  if (!outputPath || outputFlag !== Bun.argv.length - 2) {
    throw ScriptError.make({message: 'Usage: bun apps/website/tools/site-prepared-metadata.ts --output <path>'});
  }
  const siteBase = process.env.THREADNOTE_SITE_BASE ?? '/';
  const metadata = await prepareWebsiteMetadata({
    repositoryRoot: process.cwd(),
    releaseMode: websiteReleaseModeFromEnvironment(),
    siteBase,
  });
  await writePreparedWebsiteMetadata(outputPath, metadata);
  process.stdout.write(`Wrote prepared website metadata to ${outputPath}\n`);
}
