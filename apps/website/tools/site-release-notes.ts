import {Array as EffectArray} from 'effect';
import {ScriptError} from './effect/errors.js';
import {websiteReleaseSocialImageTemplateRevision} from './site-release-social-image.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface StableReleaseVersion {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface PublishedReleaseRef extends StableReleaseVersion {
  readonly publishedAt: string;
}

export interface WebsiteRelease extends PublishedReleaseRef {
  readonly body: string;
  readonly headline: string;
  readonly summary: string;
  readonly highlights: readonly string[];
  readonly releaseUrl: string;
  readonly socialImage: string;
  readonly socialImageAlt: string;
}

interface WebsiteReleaseSource extends PublishedReleaseRef {
  readonly noteRef: string;
}

const STABLE_RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;
const releaseHeadlineMaximumLength = 240;

export function parseStableReleaseVersion(version: string): StableReleaseVersion | undefined {
  const match = STABLE_RELEASE.exec(version);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!EffectArray.every([major, minor, patch], Number.isSafeInteger)) return undefined;
  return {major, minor, patch, version};
}

function compareReleasesDescending(left: StableReleaseVersion, right: StableReleaseVersion): number {
  return right.major - left.major || right.minor - left.minor || right.patch - left.patch;
}

export function selectLatestMajorReleases(releases: readonly PublishedReleaseRef[]): readonly PublishedReleaseRef[] {
  if (releases.length === 0) return [];
  const latestMajor = Math.max(...EffectArray.map(releases, release => release.major));
  const byVersion = new Map<string, PublishedReleaseRef>();
  for (const release of releases) {
    if (release.major === latestMajor) byVersion.set(release.version, release);
  }
  return [...byVersion.values()].sort(compareReleasesDescending);
}

export function selectPublishedReleaseRefs<T extends PublishedReleaseRef>(
  tagged: readonly T[],
  publishedAtByTag: ReadonlyMap<string, string>,
): readonly T[] {
  return EffectArray.flatMap(tagged, release => {
    const publishedAt = publishedAtByTag.get(release.version);
    return publishedAt === undefined ? [] : [{...release, publishedAt}];
  });
}

export function parsePublishedWebsiteReleases(manifestJson: string): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw ScriptError.make({message: 'Published website release metadata is not valid JSON.'});
  }
  if (!EffectArray.isArray(parsed) || parsed.length === 0) {
    throw ScriptError.make({message: 'Published website release metadata must contain releases.'});
  }
  const publishedAtByTag = new Map<string, string>();
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('tagName' in entry) ||
      !('publishedAt' in entry) ||
      typeof entry.tagName !== 'string' ||
      typeof entry.publishedAt !== 'string' ||
      Number.isNaN(Date.parse(entry.publishedAt))
    ) {
      throw ScriptError.make({message: 'Published website release metadata has an invalid entry.'});
    }
    if (parseStableReleaseVersion(entry.tagName) !== undefined) {
      publishedAtByTag.set(entry.tagName, entry.publishedAt);
    }
  }
  if (publishedAtByTag.size === 0) {
    throw ScriptError.make({message: 'Published website release metadata has no stable releases.'});
  }
  return publishedAtByTag;
}

function plainText(markdown: string): string {
  return Effect.pipe(
    markdown,
    EffectString.replace(/\[([^\]]+)]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1'),
    EffectString.replace(/[`*_~]/g, ''),
    EffectString.replace(/\s+/g, ' '),
    EffectString.trim,
  );
}

export function summarizeReleaseNote(markdown: string): {
  readonly summary: string;
  readonly highlights: readonly string[];
} {
  const normalized = Effect.pipe(markdown, EffectString.replace(/\r\n?/g, '\n'));
  const body = Effect.pipe(normalized, EffectString.replace(/^## What's new\s*/i, ''));
  const lines = Effect.pipe(body, EffectString.split('\n'));
  const summaryLines: string[] = [];
  let startedSummary = false;

  for (const line of lines) {
    const trimmed = Effect.pipe(line, EffectString.trim);
    if (
      !startedSummary &&
      (!trimmed ||
        Effect.pipe(trimmed, EffectString.startsWith('#')) ||
        Effect.pipe(trimmed, EffectString.startsWith('- ')))
    )
      continue;
    if (startedSummary && !trimmed) break;
    if (Effect.pipe(trimmed, EffectString.startsWith('#')) || Effect.pipe(trimmed, EffectString.startsWith('- ')))
      break;
    startedSummary = true;
    summaryLines.push(trimmed);
  }

  const sectionHeadings = EffectArray.map(
    EffectArray.filter(
      EffectArray.map(lines, line => /^###\s+(.+)$/.exec(Effect.pipe(line, EffectString.trim))?.[1]),
      (heading): heading is string => Boolean(heading),
    ),
    plainText,
  );
  const bulletHeadings = EffectArray.map(
    EffectArray.filter(
      EffectArray.map(lines, line => /^-\s+\*\*(.+?)\.?\*\*/.exec(Effect.pipe(line, EffectString.trim))?.[1]),
      (heading): heading is string => Boolean(heading),
    ),
    plainText,
  );

  return {
    summary: plainText(EffectArray.join(summaryLines, ' ')),
    highlights: [...new Set(sectionHeadings.length > 0 ? sectionHeadings : bulletHeadings)],
  };
}

export function releaseHeadlineFromSummary(summary: string): string {
  const sentence = /^.*?[.!?](?=\s|$)/u.exec(summary)?.[0];
  if (!sentence)
    throw ScriptError.make({message: 'The release-note opening summary must contain a complete first sentence.'});
  const withoutProductVersion = Effect.pipe(sentence, EffectString.replace(/^Threadnote\s+\d+(?:\.\d+){0,2}\s+/u, ''));
  const withoutCopula = Effect.pipe(withoutProductVersion, EffectString.replace(/^is\s+/u, ''));
  const headline = withoutCopula
    ? `${Effect.pipe(withoutCopula[0], EffectString.toUpperCase)}${Effect.pipe(withoutCopula, EffectString.slice(1))}`
    : sentence;
  if (!Effect.pipe(headline, EffectString.trim))
    throw ScriptError.make({message: 'The release-note opening sentence must contain a social-card headline.'});
  if (headline.length > releaseHeadlineMaximumLength) {
    throw ScriptError.make({
      message: `The release-note opening sentence must produce a social-card headline of at most ${releaseHeadlineMaximumLength} characters.`,
    });
  }
  return headline;
}

function releaseSocialImage(version: string, headline: string): string {
  const digest = Effect.pipe(
    new Bun.CryptoHasher('sha256')
      .update(`${websiteReleaseSocialImageTemplateRevision}\0${version}\0${headline}`)
      .digest('hex'),
    EffectString.slice(0, 12),
  );
  return `whats-new/releases/${version}/social-card.${digest}.png`;
}

function runGit(repositoryRoot: string, arguments_: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    const detail = Effect.pipe(result.stderr.toString(), EffectString.trim);
    throw ScriptError.make({message: `Could not load website release notes${detail ? `: ${detail}` : '.'}`});
  }
  return result.stdout.toString();
}

export function loadLatestMajorWebsiteReleases(
  repositoryRoot: string,
  publishedReleaseManifest = process.env.THREADNOTE_SITE_PUBLISHED_RELEASES,
): readonly WebsiteRelease[] {
  if (process.env.THREADNOTE_SITE_PUBLIC_BUILD === '1' && publishedReleaseManifest === undefined) {
    throw ScriptError.make({message: 'Public website builds require published GitHub release metadata.'});
  }
  const nonEmptyLines: ReadonlyArray<string> = EffectArray.filter(
    EffectArray.map(
      Effect.pipe(
        runGit(repositoryRoot, ['for-each-ref', '--format=%(refname:short)|%(creatordate:iso-strict)', 'refs/tags/v*']),
        EffectString.split('\n'),
      ),
      line => Effect.pipe(line, EffectString.trim),
    ),
    (line): line is string => typeof line === 'string' && line.length > 0,
  );
  const tagged = EffectArray.flatMap(nonEmptyLines, line => {
    const separator = Effect.pipe(
      line,
      EffectString.indexOf('|'),
      Effect.Option.getOrElse(() => -1),
    );
    if (separator < 0) return [];
    const version = Effect.pipe(line, EffectString.slice(0, separator));
    const parsed = parseStableReleaseVersion(version);
    if (!parsed) return [];
    return [
      {
        ...parsed,
        noteRef: version,
        publishedAt: Effect.pipe(line, EffectString.slice(separator + 1)),
      } satisfies WebsiteReleaseSource,
    ];
  });
  const refs =
    publishedReleaseManifest === undefined
      ? tagged
      : selectPublishedReleaseRefs(tagged, parsePublishedWebsiteReleases(publishedReleaseManifest));

  const selected = selectLatestMajorReleases(refs);
  if (selected.length === 0)
    throw ScriptError.make({message: 'The website needs at least one published stable release.'});
  const sourcesByVersion = new Map(EffectArray.map(refs, release => [release.version, release]));

  return EffectArray.map(selected, release => {
    const releaseNotePath = `.github/release-notes/${release.version}.md`;
    const source = sourcesByVersion.get(release.version);
    if (source === undefined)
      throw ScriptError.make({message: `Could not resolve website release source for ${release.version}.`});
    const markdown = runGit(repositoryRoot, ['show', `${source.noteRef}:${releaseNotePath}`]);
    const {summary, highlights} = summarizeReleaseNote(markdown);
    if (!summary) throw ScriptError.make({message: `${releaseNotePath} needs an introductory release summary.`});
    const headline = releaseHeadlineFromSummary(summary);
    const socialImage = releaseSocialImage(release.version, headline);
    return {
      ...release,
      body: markdown,
      headline,
      highlights,
      releaseUrl: `https://github.com/threadnote/threadnote/releases/tag/${release.version}`,
      socialImage,
      socialImageAlt: `Threadnote ${Effect.pipe(release.version, EffectString.replace(/^v/, ''))} — ${headline}`,
      summary,
    };
  });
}
