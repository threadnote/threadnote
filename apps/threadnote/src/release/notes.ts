import {Effect, Schema} from 'effect';
import {getJsonEffect} from '@threadnote/platform/http';
import {GITHUB_RELEASES_URL, githubReleaseHeaders} from './github_auth.js';
import {compareVersions, isJsonObject} from '../utils.js';
import {errorMessage} from '@threadnote/platform/errors';

class ReleaseNotesError extends Schema.TaggedError<ReleaseNotesError>()('ReleaseNotesError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const RELEASE_FETCH_TIMEOUT_MS = 3500;

export interface ReleaseNote {
  readonly body: string;
  readonly title: string;
  readonly url?: string;
  readonly version: string;
}

interface ReleaseNotesOptions {
  readonly allowCredentialCommand?: boolean;
  readonly includePrereleases?: boolean;
}

export const fetchThreadnoteReleaseNotes = Effect.fn('fetchThreadnoteReleaseNotes')(function* (
  options: ReleaseNotesOptions = {},
) {
  const headers = yield* githubReleaseHeaders(GITHUB_RELEASES_URL, options);
  const response = yield* getJsonEffect(GITHUB_RELEASES_URL, {
    headers,
    timeoutMs: RELEASE_FETCH_TIMEOUT_MS,
  });
  if (!Array.isArray(response.body)) {
    return yield* ReleaseNotesError.make({message: 'GitHub releases response was not an array.'});
  }
  return response.body.flatMap(value => parseGithubRelease(value, options.includePrereleases === true));
});

export function releasesBetween(
  releases: readonly ReleaseNote[],
  currentVersion: string,
  latestVersion: string,
): readonly ReleaseNote[] {
  return releases
    .filter(
      release =>
        compareVersions(release.version, currentVersion) > 0 && compareVersions(release.version, latestVersion) <= 0,
    )
    .sort((left, right) => compareVersions(left.version, right.version));
}

export function releaseForVersion(releases: readonly ReleaseNote[], version: string): readonly ReleaseNote[] {
  return releases.filter(release => compareVersions(release.version, version) === 0).slice(0, 1);
}

export function formatWhatsNew(releases: readonly ReleaseNote[]): readonly string[] {
  if (releases.length === 0) {
    return [];
  }
  const lines = ["What's new:"];
  for (const release of releases) {
    lines.push(`${release.version}: ${release.title || 'Release notes'}`);
    for (const line of bodyLines(release.body)) {
      lines.push(`  ${line}`);
    }
  }
  return lines;
}

export const whatsNewLinesForVersion = Effect.fn('whatsNewLinesForVersion')(
  (version: string, options: ReleaseNotesOptions = {}) =>
    fetchThreadnoteReleaseNotes(options).pipe(
      Effect.map(releases => {
        const lines = formatWhatsNew(releaseForVersion(releases, version));
        return lines.length > 0 ? lines : ["What's new:", `No GitHub release notes found for ${version}.`];
      }),
      Effect.catch(error => Effect.succeed([`What's new: unavailable (${errorMessage(error)})`])),
    ),
);

export const whatsNewLinesForVersionRange = Effect.fn('whatsNewLinesForVersionRange')(function (
  currentVersion: string,
  latestVersion: string,
  options: ReleaseNotesOptions = {},
) {
  return fetchThreadnoteReleaseNotes(options).pipe(
    Effect.map(releases => {
      const lines = formatWhatsNew(releasesBetween(releases, currentVersion, latestVersion));
      return lines.length > 0 ? lines : ["What's new:", 'No GitHub release notes found for this version range.'];
    }),
    Effect.catch(error => Effect.succeed([`What's new: unavailable (${errorMessage(error)})`])),
  );
});

function parseGithubRelease(value: unknown, includePrereleases: boolean): readonly ReleaseNote[] {
  if (!isJsonObject(value) || value.draft === true || (!includePrereleases && value.prerelease === true)) {
    return [];
  }
  const tagName = typeof value.tag_name === 'string' ? value.tag_name : '';
  const version = tagName.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-.A-Za-z0-9]+)?$/.test(version)) {
    return [];
  }
  const name = typeof value.name === 'string' ? value.name : tagName;
  const body = typeof value.body === 'string' ? value.body : '';
  const url = typeof value.html_url === 'string' ? value.html_url : undefined;
  return [{body, title: titleFromReleaseName(name, version), url, version}];
}

function titleFromReleaseName(name: string, version: string): string {
  const trimmed = name.trim();
  const withoutPrefix = trimmed.replace(new RegExp(`^v?${escapeRegExp(version)}:\\s*`, 'i'), '');
  return withoutPrefix || trimmed || 'Release notes';
}

function bodyLines(body: string): readonly string[] {
  const out: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s+/.test(line)) {
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      out.push(`- ${line.replace(/^[-*]\s+/, '')}`);
    } else {
      out.push(line);
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
