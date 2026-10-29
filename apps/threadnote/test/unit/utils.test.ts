import {Array as EffectArray, Option as EffectOption} from 'effect';
import {chmod, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Effect} from 'effect';
import fc from 'fast-check';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {MemoryRecord} from '@threadnote/memory/document';
import {
  applyExactMatchBoost,
  buildRecallSections,
  categoryForUri,
  collectExactMatches as collectExactMatchesEffect,
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  formatExactMatchPointers,
  formatRecallHits,
  grepUrisFromJson,
  isAgentArtifactPackUri,
  memoryFrontmatterField,
  memoryUriProjectSegment,
  mergeRecallHits,
  parseRecallHits,
  RECALL_LOW_CONFIDENCE_NOTE,
  type RecallHit,
} from '@threadnote/recall/results';
import {
  compareVersions,
  enrichRecallQueryWithWorkspaceContext as enrichRecallQueryWithWorkspaceContextEffect,
  escapeRegExp,
  formatShellCommand,
  formatStaleVersionNotice,
  getGlobBase,
  hasGlob,
  isExecutable as isExecutableEffect,
  isJsonObject,
  parseJsonConfigObject,
  recallQueryRequestsWorkspaceContext,
  redactText,
  reindexWaitTimeoutMs,
  runCommand as runCommandEffect,
  runInteractive as runInteractiveEffect,
  shellQuote,
  suggestedShellRc,
  uniqueUsefulWorkspaceTerms,
} from '@threadnote/threadnote/utils';
import {globToRegExp} from '@threadnote/platform/glob';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function rankingMemoryRecord(uri: string, body: string): MemoryRecord {
  return {
    body,
    content: `MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: topic\n\n${body}`,
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-07-23T00:00:00.000Z',
      topic: 'topic',
    },
    uri,
  };
}

const collectExactMatches = (
  terms: readonly string[],
  scopes: readonly string[],
  runGrep: (term: string, scope: string) => Effect.Effect<string | undefined>,
) => runEffect(collectExactMatchesEffect(terms, scopes, runGrep));
const enrichRecallQueryWithWorkspaceContext = (
  ...args: Parameters<typeof enrichRecallQueryWithWorkspaceContextEffect>
) => runEffect(enrichRecallQueryWithWorkspaceContextEffect(...args));
const isExecutable = (...args: Parameters<typeof isExecutableEffect>) => runEffect(isExecutableEffect(...args));
const runCommand = (...args: Parameters<typeof runCommandEffect>) => runEffect(runCommandEffect(...args));
const runInteractive = (...args: Parameters<typeof runInteractiveEffect>) => runEffect(runInteractiveEffect(...args));

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('returns positive when left > right', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0', '1.2.99')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('returns negative when left < right', () => {
    expect(compareVersions('0.3.23', '0.3.24')).toBeLessThan(0);
    expect(compareVersions('0.7.2', '0.7.4')).toBeLessThan(0);
  });

  it('treats a missing prerelease as newer than any prerelease', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
  });

  it('orders prereleases lexicographically', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc2', '1.0.0-rc1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0-rc1')).toBe(0);
  });

  it('orders numeric prerelease identifiers numerically', () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
  });

  it('coerces missing or non-numeric components to 0', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('abc', '0.0.0')).toBe(0);
  });

  it('ignores build metadata so a local build is not misread as an older minor', () => {
    expect(compareVersions('0.4.4+local.1', '0.4.4')).toBe(0);
    expect(compareVersions('0.4.4+local', '0.4.3')).toBeGreaterThan(0);
  });

  it('treats PEP 440 post-releases as newer and pre-releases as older', () => {
    expect(compareVersions('0.4.4.post1', '0.4.4')).toBeGreaterThan(0);
    expect(compareVersions('0.4.4', '0.4.4.post1')).toBeLessThan(0);
    expect(compareVersions('0.4.4rc1', '0.4.4')).toBeLessThan(0);
    expect(compareVersions('0.4.4.dev0', '0.4.4')).toBeLessThan(0);
  });
});

describe('reindexWaitTimeoutMs', () => {
  const ENV = 'THREADNOTE_REINDEX_TIMEOUT_MS';
  const original = process.env[ENV];
  afterAll(() => {
    if (original === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = original;
    }
  });

  it('defaults to a bounded 2-minute wait', () => {
    delete process.env[ENV];
    return expect(runEffect(reindexWaitTimeoutMs())).resolves.toBe(120_000);
  });

  it('honors a positive integer override', () => {
    process.env[ENV] = '30000';
    return expect(runEffect(reindexWaitTimeoutMs())).resolves.toBe(30_000);
  });

  it('falls back to the default for non-positive or invalid overrides', async () => {
    process.env[ENV] = '0';
    await expect(runEffect(reindexWaitTimeoutMs())).resolves.toBe(120_000);
    process.env[ENV] = 'nope';
    await expect(runEffect(reindexWaitTimeoutMs())).resolves.toBe(120_000);
  });
});

describe('formatStaleVersionNotice', () => {
  it('returns a reconnect notice naming both versions when disk is newer', () => {
    const notice = formatStaleVersionNotice('1.4.0', '1.4.1');
    expect(notice).toContain('1.4.1');
    expect(notice).toContain('1.4.0');
    expect(notice).toMatch(/reconnect/i);
  });

  it('returns undefined when versions match or disk is older or equal', () => {
    expect(formatStaleVersionNotice('1.4.1', '1.4.1')).toBeUndefined();
    expect(formatStaleVersionNotice('1.4.1', '1.4.0')).toBeUndefined();
  });

  it('returns undefined when either version is unknown', () => {
    expect(formatStaleVersionNotice(undefined, '1.4.1')).toBeUndefined();
    expect(formatStaleVersionNotice('1.4.0', undefined)).toBeUndefined();
  });
});

describe('parseJsonConfigObject', () => {
  it('returns the parsed object for valid JSON objects', () => {
    expect(parseJsonConfigObject('{"a":1}')).toEqual({a: 1});
    expect(parseJsonConfigObject('  {"nested":{"b":2}}  ')).toEqual({nested: {b: 2}});
  });

  it('returns undefined for arrays', () => {
    expect(parseJsonConfigObject('[1,2,3]')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(parseJsonConfigObject('null')).toBeUndefined();
  });

  it('returns undefined for primitives', () => {
    expect(parseJsonConfigObject('"string"')).toBeUndefined();
    expect(parseJsonConfigObject('42')).toBeUndefined();
    expect(parseJsonConfigObject('true')).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseJsonConfigObject('{invalid')).toBeUndefined();
    expect(parseJsonConfigObject('')).toBeUndefined();
  });
});

describe('isJsonObject', () => {
  it('accepts plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({a: 1})).toBe(true);
  });

  it('rejects arrays, null, and primitives', () => {
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('s')).toBe(false);
    expect(isJsonObject(1)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe('redactText', () => {
  it('redacts key=value pairs for secret-shaped keys', () => {
    expect(redactText('api_key=abc123def456')).toBe('api_key=[REDACTED]');
    expect(redactText('TOKEN=value123')).toBe('TOKEN=[REDACTED]');
    expect(redactText('authorization: "hunter2"')).toBe('authorization: [REDACTED]');
  });

  it('redacts bearer tokens', () => {
    expect(redactText('Bearer abcdefghijklmnopqrst')).toBe('<secret>');
  });

  it('redacts sk-* api keys', () => {
    expect(redactText('use sk-abcdefghijklmnopqrstuv now')).toBe('use <secret> now');
  });

  it('redacts github personal access tokens that appear outside key=value contexts', () => {
    expect(redactText('value: ghp_abcdefghijklmnopqrst')).toBe('value: <secret>');
  });

  it('redacts provider tokens and credential URLs that appear outside key=value contexts', () => {
    expect(redactText('dsn postgres://user:password@db.example.com/app')).toBe('dsn <secret>');
    expect(
      redactText(
        EffectArray.join(['webhook https://hooks.slack.com/services/T00000000/B00000000/', 'abcdefghijklmnop'], ''),
      ),
    ).toBe('webhook <secret>');
  });

  it('leaves non-secret text untouched', () => {
    expect(redactText('hello world')).toBe('hello world');
  });
});

describe('runCommand guardrails', () => {
  it('rejects when a command exceeds the configured timeout', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'setTimeout(() => undefined, 5000)'], {timeoutMs: 50}),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it('returns a timeout result when allowFailure is set', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => undefined, 5000)'], {
      allowFailure: true,
      timeoutMs: 50,
    });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out after 50ms');
  });

  it('caps accumulated output', async () => {
    const script = 'process.stdout.write("x".repeat(1024));';
    const result = await runCommand(process.execPath, ['-e', script], {allowFailure: true, maxOutputBytes: 16});
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('exceeded output limit of 16 bytes');
  });

  it('supports explicitly unbounded output collection for repository inventory commands', async () => {
    const script = 'process.stdout.write("x".repeat(1024));';
    const result = await runCommand(process.execPath, ['-e', script], {maxOutputBytes: 0});
    expect(result.stdout).toHaveLength(1024);
  });

  it('escalates after timeout when the child ignores SIGTERM', async () => {
    const script = 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000);';
    const result = await runCommand(process.execPath, ['-e', script], {allowFailure: true, timeoutMs: 20});
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out after 20ms');
  });
});

describe('runInteractive', () => {
  it('returns the child exit code', async () => {
    expect(await runInteractive(process.execPath, ['-e', 'process.exit(0)'])).toBe(0);
    expect(await runInteractive(process.execPath, ['-e', 'process.exit(3)'])).toBe(3);
  });

  it('resolves non-zero instead of hanging when the binary cannot be spawned', async () => {
    expect(await runInteractive('threadnote-nonexistent-binary-xyz', ['--version'])).toBe(1);
  });
});

describe('globToRegExp', () => {
  it('matches a single path segment with *', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/foo/bar.ts')).toBe(false);
  });

  it('matches across path segments with **', () => {
    const re = globToRegExp('src/**/*.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/foo/bar.ts')).toBe(true);
    expect(re.test('src/foo/bar/baz.ts')).toBe(true);
    expect(re.test('out/foo.ts')).toBe(false);
  });

  it('matches one char with ?', () => {
    const re = globToRegExp('a?.txt');
    expect(re.test('ab.txt')).toBe(true);
    expect(re.test('abc.txt')).toBe(false);
  });

  it('escapes regex metacharacters in literal text', () => {
    const re = globToRegExp('a.b');
    expect(re.test('a.b')).toBe(true);
    expect(re.test('axb')).toBe(false);
  });
});

describe('getGlobBase', () => {
  it('returns the path up to the first wildcard segment', () => {
    expect(getGlobBase('src/**/*.ts')).toBe('src');
    expect(getGlobBase('a/b/c/*.ts')).toBe('a/b/c');
    expect(getGlobBase('docs/index.md')).toBe('docs/index.md');
  });

  it('returns "." when the pattern starts with a wildcard', () => {
    expect(getGlobBase('*.ts')).toBe('.');
    expect(getGlobBase('**/*.ts')).toBe('.');
  });
});

describe('hasGlob', () => {
  it('detects * and ?', () => {
    expect(hasGlob('*.ts')).toBe(true);
    expect(hasGlob('a?b')).toBe(true);
  });

  it('returns false for plain paths', () => {
    expect(hasGlob('src/foo.ts')).toBe(false);
  });
});

describe('escapeRegExp', () => {
  it('escapes all regex metacharacters', () => {
    expect(escapeRegExp('a.b')).toBe('a\\.b');
    expect(escapeRegExp('(x)')).toBe('\\(x\\)');
    expect(escapeRegExp('a|b')).toBe('a\\|b');
    expect(escapeRegExp('a*b')).toBe('a\\*b');
  });
});

describe('exactRecallTerms', () => {
  it('keeps branch/topic-shaped terms and drops generic recall words', () => {
    expect(exactRecallTerms('coda latest handoff durable feature memory valencia-v1')).toEqual(['valencia-v1', 'coda']);
  });

  it('keeps stable issue topic slugs', () => {
    expect(exactRecallTerms('recall mobile-checkbox-clipped-table-cell handoff')).toEqual([
      'mobile-checkbox-clipped-table-cell',
    ]);
  });

  it('keeps short distinctive acronyms without admitting generic three-letter words', () => {
    expect(exactRecallTerms('QX7 worker lease for the app')).toEqual(['QX7', 'worker', 'lease']);
  });

  it('drops expanded generic function words so they cannot re-flood recall', () => {
    // A sentence built only from stop words yields no exact grep terms.
    expect(exactRecallTerms('what have they which does that when were')).toEqual([]);
    // A distinctive token still survives among the same filler.
    expect(exactRecallTerms('what does the sharding do')).toEqual(['sharding']);
  });

  it('extracts NFC-normalized Ukrainian exact terms without dropping apostrophes', () => {
    const terms = exactRecallTerms('згадай пам’ять про Київ та київський-2026');
    expect(terms).toContain("пам'ять");
    expect(terms).toContain('Київ');
    expect(terms).toContain('київський-2026');
  });
});

describe('recallQueryRequestsWorkspaceContext', () => {
  it('detects current branch and repo wording', () => {
    for (const phrase of [
      'this branch',
      'current branch',
      'this repo',
      'current repo',
      'this repository',
      'current repository',
      'this workspace',
      'current workspace',
      'this worktree',
      'current worktree',
    ]) {
      expect(recallQueryRequestsWorkspaceContext(`latest handoff for ${phrase}`)).toBe(true);
    }
  });

  it('leaves explicit recall queries alone', () => {
    expect(recallQueryRequestsWorkspaceContext('coda valencia-v1 latest handoff')).toBe(false);
  });
});

describe('enrichRecallQueryWithWorkspaceContext', () => {
  it('returns explicit queries unchanged', async () => {
    await expect(enrichRecallQueryWithWorkspaceContext('coda valencia-v1 latest handoff')).resolves.toBe(
      'coda valencia-v1 latest handoff',
    );
  });
});

describe('uniqueUsefulWorkspaceTerms', () => {
  it('keeps short branch names but drops short path terms', () => {
    expect(
      uniqueUsefulWorkspaceTerms([
        {source: 'branch', value: 'v1'},
        {source: 'path', value: 'v1'},
        {source: 'path', value: 'coda'},
      ]),
    ).toEqual(['v1', 'coda']);
  });

  it('drops ignored path terms and deduplicates case-insensitively', () => {
    expect(
      uniqueUsefulWorkspaceTerms([
        {source: 'path', value: 'repos'},
        {source: 'path', value: 'workspaces'},
        {source: 'branch', value: 'Fix'},
        {source: 'path', value: 'fix'},
      ]),
    ).toEqual(['Fix']);
  });
});

describe('shellQuote', () => {
  it('leaves safe identifiers unquoted', () => {
    expect(shellQuote('foo')).toBe('foo');
    expect(shellQuote('/usr/bin/env')).toBe('/usr/bin/env');
    expect(shellQuote('a-b_c.d')).toBe('a-b_c.d');
  });

  it('single-quotes anything with shell-significant characters', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
    expect(shellQuote('a;b')).toBe("'a;b'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
  });
});

describe('formatShellCommand', () => {
  it('quotes args containing spaces', () => {
    expect(formatShellCommand('echo', ['hello world'])).toBe("echo 'hello world'");
  });

  it('redacts secret-looking args', () => {
    const formatted = formatShellCommand('curl', ['-H', 'Authorization: Bearer abc123def456']);
    expect(formatted).toContain('[REDACTED]');
    expect(formatted).not.toContain('abc123def456');
  });
});

describe('isExecutable', () => {
  let tmpRoot: string;
  let executablePath: string;
  let plainPath: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'threadnote-isexec-'));
    executablePath = join(tmpRoot, 'runnable');
    plainPath = join(tmpRoot, 'plain');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await chmod(executablePath, 0o755);
    await writeFile(plainPath, 'not executable');
    await chmod(plainPath, 0o644);
  });

  afterAll(async () => {
    await rm(tmpRoot, {recursive: true, force: true});
  });

  it('returns true for files with the executable bit set', async () => {
    expect(await isExecutable(executablePath)).toBe(true);
  });

  it('returns false for files without the executable bit', async () => {
    expect(await isExecutable(plainPath)).toBe(false);
  });

  it('returns false for nonexistent paths', async () => {
    expect(await isExecutable(join(tmpRoot, 'does-not-exist'))).toBe(false);
  });
});

describe('suggestedShellRc', () => {
  it('returns ~/.zshrc for zsh', () => {
    expect(suggestedShellRc('/bin/zsh', 'darwin')).toBe('~/.zshrc');
    expect(suggestedShellRc('/usr/local/bin/zsh', 'linux')).toBe('~/.zshrc');
  });

  it('returns ~/.bash_profile for bash on macOS', () => {
    expect(suggestedShellRc('/bin/bash', 'darwin')).toBe('~/.bash_profile');
  });

  it('returns ~/.bashrc for bash on Linux', () => {
    expect(suggestedShellRc('/bin/bash', 'linux')).toBe('~/.bashrc');
  });

  it('returns fish config path for fish', () => {
    expect(suggestedShellRc('/opt/homebrew/bin/fish', 'darwin')).toBe('~/.config/fish/config.fish');
  });

  it('falls back to a generic message for unknown or empty shells', () => {
    expect(suggestedShellRc(undefined, 'darwin')).toBe('your shell rc');
    expect(suggestedShellRc('', 'linux')).toBe('your shell rc');
    expect(suggestedShellRc('/usr/local/bin/something-else', 'darwin')).toBe('your shell rc');
  });
});

describe('exactRecallScopeIntents', () => {
  it('routes a writing-style query to preferences only', () => {
    expect([...exactRecallScopeIntents('Denys writing style tone for PR replies')]).toEqual(['preferences']);
  });

  it('routes handoff, durable, and incident intents', () => {
    expect([...exactRecallScopeIntents('latest handoff status and next step')]).toEqual(['handoffs']);
    expect([...exactRecallScopeIntents('durable feature design decision and invariants')]).toEqual(['durable']);
    expect([...exactRecallScopeIntents('incident outage postmortem on-call')]).toEqual(['incidents']);
  });

  it('accumulates multiple intents', () => {
    expect([...exactRecallScopeIntents('writing style preference for the latest handoff status')].sort()).toEqual([
      'handoffs',
      'preferences',
    ]);
  });

  it('does not classify incidental dev vocabulary as durable intent', () => {
    expect(exactRecallScopeIntents('refactor the auth design and interface').size).toBe(0);
  });

  it('returns an empty set when intent is unclear', () => {
    expect(exactRecallScopeIntents('threadnote release notes commit').size).toBe(0);
  });
});

describe('exactMemoryScopeUris', () => {
  const base = {
    agentMemoriesUri: 'threadnote://agent/threadnote/memories',
    userBase: 'threadnote://user/denys/memories',
  };

  it('searches preferences and shared for a preferences intent', () => {
    expect(exactMemoryScopeUris({...base, includeArchived: false, intents: new Set(['preferences'] as const)})).toEqual(
      [
        'threadnote://user/denys/memories/preferences',
        'threadnote://user/denys/memories/shared',
        'threadnote://resources/external',
      ],
    );
  });

  it('narrows project-specific scopes to the resolved project, leaving preferences and shared global', () => {
    expect(
      exactMemoryScopeUris({
        ...base,
        includeArchived: false,
        intents: new Set(['durable', 'handoffs', 'preferences'] as const),
        projectName: 'threadnote',
        projectResourceUri: 'threadnote://resources/repos/threadnote',
      }),
    ).toEqual([
      'threadnote://user/denys/memories/preferences',
      'threadnote://user/denys/memories/durable/projects/threadnote',
      'threadnote://user/denys/memories/handoffs/active/threadnote',
      'threadnote://user/denys/memories/shared',
      'threadnote://resources/external',
    ]);
  });

  it('appends archived scopes for the present intents when includeArchived is set', () => {
    expect(exactMemoryScopeUris({...base, includeArchived: true, intents: new Set(['durable'] as const)})).toEqual([
      'threadnote://user/denys/memories/durable/projects',
      'threadnote://user/denys/memories/shared',
      'threadnote://resources/external',
      'threadnote://user/denys/memories/durable/archived',
    ]);
  });

  it('falls back to the broad set when intent is unclear, narrowing project scopes', () => {
    expect(
      exactMemoryScopeUris({
        ...base,
        includeArchived: false,
        intents: new Set(),
        projectName: 'threadnote',
        projectResourceUri: 'threadnote://resources/repos/threadnote',
      }),
    ).toEqual([
      'threadnote://user/denys/memories/preferences',
      'threadnote://user/denys/memories/durable/projects/threadnote',
      'threadnote://user/denys/memories/handoffs/active/threadnote',
      'threadnote://user/denys/memories/incidents/active/threadnote',
      'threadnote://user/denys/memories/shared',
      'threadnote://agent/threadnote/memories',
      'threadnote://resources/repos/threadnote',
      'threadnote://resources/external',
    ]);
  });
});

describe('grepUrisFromJson', () => {
  it('extracts match URIs past the cmd: banner', () => {
    const output =
      'cmd: ov grep --uri=x\n{"ok":true,"result":{"matches":[{"line":1,"uri":"threadnote://a.md","content":"x"},{"line":2,"uri":"threadnote://b.md","content":"y"}],"count":2}}';
    expect(grepUrisFromJson(output)).toEqual(['threadnote://a.md', 'threadnote://b.md']);
  });

  it('drops .overview/.abstract summary sidecars', () => {
    const output =
      '{"ok":true,"result":{"matches":[{"line":1,"uri":"threadnote://a/.overview.md","content":"x"},{"line":2,"uri":"threadnote://a/real.md","content":"y"},{"line":3,"uri":"threadnote://a/.abstract.md","content":"z"}]}}';
    expect(grepUrisFromJson(output)).toEqual(['threadnote://a/real.md']);
  });

  it('drops agent-artifact pack machinery so a review pack does not flood exact matches', () => {
    const output = JSON.stringify({
      ok: true,
      result: {
        matches: [
          {
            line: 1,
            uri: 'threadnote://user/me/memories/shared/default/agent-artifacts/packs/claude/r/r.pack.json',
            content: 'x',
          },
          {line: 2, uri: 'threadnote://user/me/memories/durable/projects/x/real.md', content: 'y'},
        ],
      },
    });
    expect(grepUrisFromJson(output)).toEqual(['threadnote://user/me/memories/durable/projects/x/real.md']);
  });

  it('returns [] on malformed output', () => {
    expect(grepUrisFromJson('cmd: ov grep\nnot json')).toEqual([]);
    expect(grepUrisFromJson('')).toEqual([]);
  });
});

describe('collectExactMatches + formatExactMatchPointers', () => {
  it('dedupes by URI, strips chunk anchors, and ranks by distinct-term count', async () => {
    const runGrep = (term: string) => {
      const uris =
        term === 'style'
          ? ['threadnote://prefs.md#chunk_0001', 'threadnote://other.md']
          : term === 'tone'
            ? ['threadnote://prefs.md#chunk_0002']
            : [];
      return Effect.succeed(
        JSON.stringify({ok: true, result: {matches: EffectArray.map(uris, (uri, line) => ({line, uri, content: ''}))}}),
      );
    };
    const matches = await collectExactMatches(['style', 'tone'], ['threadnote://scope'], runGrep);
    expect(matches).toEqual([
      {uri: 'threadnote://prefs.md', terms: ['style', 'tone']},
      {uri: 'threadnote://other.md', terms: ['style']},
    ]);
    const text = formatExactMatchPointers(matches);
    expect(text).toContain('Exact term matches (read the URI for full content):');
    expect(text).toContain('- threadnote://prefs.md (style, tone)');
  });

  it('does not double-count a term when the same URI matches it in two scopes', async () => {
    const runGrep = (term: string, scope: string) => {
      const uris =
        scope === 'threadnote://a'
          ? ['threadnote://dup.md']
          : scope === 'threadnote://b'
            ? ['threadnote://dup.md']
            : [];
      return Effect.succeed(
        JSON.stringify({ok: true, result: {matches: EffectArray.map(uris, (uri, line) => ({line, uri, content: ''}))}}),
      );
    };
    const matches = await collectExactMatches(['term'], ['threadnote://a', 'threadnote://b'], runGrep);
    expect(matches).toEqual([{uri: 'threadnote://dup.md', terms: ['term']}]);
  });

  it('caps the pointer list and notes the overflow', () => {
    const matches = Array.from({length: 10}, (_unused, index) => ({terms: ['t'], uri: `threadnote://m${index}.md`}));
    const text = formatExactMatchPointers(matches, 3) ?? '';
    expect(
      EffectArray.filter(
        Effect2.pipe(text, EffectString.split('\n')),
        __effectArrayValue2 => !!(line => Effect2.pipe(line, EffectString.startsWith('- ')))(__effectArrayValue2),
      ).length,
    ).toBe(3);
    expect(text).toContain('(+7 more exact matches');
  });

  it('returns undefined when there are no matches', () => {
    expect(formatExactMatchPointers([])).toBeUndefined();
  });
});

describe('parseRecallHits / mergeRecallHits / formatRecallHits', () => {
  const json = (obj: unknown): string => `cmd: ov search ...\n${JSON.stringify(obj)}`;

  it('parses memories + resources, drops sidecars, and trims snippets', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [{context_type: 'memory', uri: 'threadnote://m.md#chunk_0001', score: 0.7, abstract: 'a  b\n c'}],
          resources: [
            {context_type: 'resource', uri: 'threadnote://r.md', score: 0.6, abstract: 'doc'},
            {context_type: 'resource', uri: 'threadnote://r/.overview.md', score: 0.9, abstract: 'sidecar'},
          ],
          skills: [],
        },
      }),
    );
    expect(hits).toEqual([
      {category: 'memories', contextType: 'memory', uri: 'threadnote://m.md#chunk_0001', score: 0.7, snippet: 'a b c'},
      {category: 'resources', contextType: 'resource', uri: 'threadnote://r.md', score: 0.6, snippet: 'doc'},
    ]);
  });

  it('drops agent-artifact pack machinery from semantic hits', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {
              context_type: 'memory',
              uri: 'threadnote://user/me/memories/shared/default/agent-artifacts/packs/claude/r/r.pack.json',
              score: 0.7,
              abstract: 'pack',
            },
            {
              context_type: 'memory',
              uri: 'threadnote://user/me/memories/durable/projects/x/real.md',
              score: 0.6,
              abstract: 'real',
            },
          ],
        },
      }),
    );
    expect(EffectArray.map(hits, hit => hit.uri)).toEqual(['threadnote://user/me/memories/durable/projects/x/real.md']);
  });

  it('uses the hybrid ranker for live recall and explains why a relevant canonical resource leads', () => {
    const sections = buildRecallSections(
      [
        parseRecallHits(
          json({
            ok: true,
            result: {
              memories: [
                {
                  context_type: 'memory',
                  uri: 'threadnote://user/me/memories/durable/projects/threadnote/general.md',
                  score: 0.71,
                  abstract: 'General retry notes.',
                },
              ],
              resources: [
                {
                  context_type: 'resource',
                  uri: 'threadnote://resources/repos/threadnote/alpha-42.md',
                  score: 0.68,
                  abstract: 'Alpha-42 bounded retry policy.',
                },
              ],
            },
          }),
        ),
      ],
      [{terms: ['alpha-42'], uri: 'threadnote://resources/repos/threadnote/alpha-42.md'}],
      12,
      {project: 'threadnote', query: 'threadnote alpha-42 retry policy'},
    );

    expect(sections.ranked[0]?.uri).toContain('alpha-42.md');
    expect(sections.confidence?.level).not.toBe('no_answer');
    expect(sections.semanticSection).toContain('Recall confidence:');
    expect(sections.semanticSection).toContain('why:');
    expect(sections.exactTail).toBeUndefined();
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(sections.ranked[0]?.rankReasons), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, reason => reason.code),
        ),
      ),
    ).toContain('field_match');
  });

  it('does not emit rejected exact pointers after hybrid ranking', () => {
    const sections = buildRecallSections(
      [],
      [
        {terms: ['alpha-42'], uri: 'threadnote://resources/repos/threadnote/alpha-42.md'},
        {terms: ['beta-43'], uri: 'threadnote://resources/repos/threadnote/beta-43.md'},
      ],
      1,
      {
        allowExactRescue: true,
        project: 'threadnote',
        query: 'alpha-42 beta-43',
      },
    );

    expect(sections.ranked.length).toBeGreaterThan(1);
    expect(sections.exactTail).toBeUndefined();
    expect(sections.semanticSection).not.toContain('Exact term matches');
  });

  it('suppresses weak keyword-only filler when hybrid confidence is no answer', () => {
    const sections = buildRecallSections(
      [],
      [
        {
          terms: ['kubernetes'],
          uri: 'threadnote://user/me/memories/durable/projects/threadnote/incidental.md',
        },
      ],
      12,
      {project: 'threadnote', query: 'kubernetes service mesh topology'},
    );

    expect(sections.confidence?.level).toBe('no_answer');
    expect(sections.semanticSection).toContain('Recall confidence: no answer');
    expect(sections.exactTail).toBeUndefined();
    expect(sections.semanticSection).not.toContain('keyword-only:');
  });

  it('surfaces a strong lexical-only identifier from the full local index without grep promotion', () => {
    const sections = buildRecallSections([], [], 12, {
      indexedCandidates: [
        {
          authority: 'canonical_repo',
          fields: {
            identifiers: ['alpha-42'],
            project: 'threadnote',
            title: 'Alpha-42 contract',
            topic: 'alpha-42',
          },
          text: 'alpha-42 bounded retry policy',
          trust: 'approved',
          uri: 'threadnote://resources/repos/threadnote/alpha-42.md',
        },
      ],
      project: 'threadnote',
      query: 'alpha-42',
    });

    expect(sections.ranked[0]?.uri).toContain('alpha-42.md');
    expect(sections.ranked[0]?.score).toBe(0);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(sections.ranked[0]?.rankReasons), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, reason => reason.code),
        ),
      ),
    ).toEqual(expect.arrayContaining(['bm25_lexical', 'field_match']));
  });

  it('keeps vector-index semantic corroboration for a document promoted by the exact-match pass', () => {
    const uri = 'threadnote://user/me/memories/shared/threadnote/durable/projects/threadnote/dogfood-issues.md';
    const sections = buildRecallSections([], [{terms: ['dogfood-issues'], uri}], 12, {
      indexedCandidates: [
        {
          authority: 'reviewed_shared',
          fields: {
            identifiers: ['dogfood-issues'],
            project: 'threadnote',
            title: 'Threadnote dogfooding issues',
            topic: 'dogfood-issues',
          },
          kind: 'durable',
          semantic: 0.72,
          status: 'active',
          text: 'dogfood issues ledger for threadnote',
          trust: 'approved',
          uri,
        },
      ],
      project: 'threadnote',
      query: 'dogfood-issues',
    });

    expect(sections.ranked[0]?.uri).toBe(uri);
    expect(sections.ranked[0]?.rankSignals?.semantic).toBeCloseTo(0.72);
    expect(sections.ranked[0]?.rankWarnings ?? []).not.toContain(
      'lexical-only result; no semantic or graph corroboration',
    );
  });

  it('rescues an authoritative exact shared memory before hybrid reranking', () => {
    const uri =
      'threadnote://user/me/memories/shared/default/durable/projects/threadnote/windows-installation-support.md';
    const sections = buildRecallSections(
      [
        [
          {
            category: 'memories',
            contextType: 'memory',
            score: 0.71,
            snippet: 'Windows installation remains unsupported and is documented in shared durable memory.',
            uri: 'threadnote://user/me/memories/handoffs/active/threadnote/recall-and-memory-formation.md',
          },
        ],
      ],
      [{terms: ['windows'], uri}],
      5,
      {
        allowExactRescue: true,
        minimumScore: 0.45,
        project: 'threadnote',
        query: 'threadnote can users install reliably on native Windows what remains unsupported',
        records: [
          {
            body: 'Native Windows installation remains unsupported until package, model, and lifecycle gates pass.',
            content:
              'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\ntopic: windows-installation-support\n\nNative Windows installation remains unsupported until package, model, and lifecycle gates pass.',
            headerTitle: 'MEMORY',
            metadata: {
              kind: 'durable',
              project: 'threadnote',
              sourceAgentClient: 'codex',
              status: 'active',
              timestamp: '2026-07-23T00:00:00.000Z',
              topic: 'windows-installation-support',
            },
            uri,
          },
        ],
      },
    );

    expect(sections.ranked[0]?.uri).toBe(uri);
    expect(sections.ranked[0]?.score).toBe(0);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(sections.ranked[0]?.rankReasons), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, reason => reason.code),
        ),
      ),
    ).toEqual(expect.arrayContaining(['bm25_lexical', 'exact_term_match', 'field_match', 'memory_kind_intent']));
    expect(sections.semanticSection).not.toContain(RECALL_LOW_CONFIDENCE_NOTE);
  });

  it('caps hydrated record authority and trust at the personal-memory boundary', () => {
    const uri = 'threadnote://user/me/memories/durable/projects/threadnote/unreviewed.md';
    const sections = buildRecallSections(
      [
        [
          {
            category: 'memories',
            contextType: 'memory',
            score: 0.8,
            snippet: 'authority boundary anchor',
            uri,
          },
        ],
      ],
      [],
      12,
      {
        query: 'authority boundary anchor',
        records: [
          {
            body: 'authority boundary anchor',
            content: 'authority boundary anchor',
            headerTitle: 'MEMORY',
            metadata: {
              authority: 'canonical_repo',
              kind: 'durable',
              project: 'threadnote',
              sourceAgentClient: 'external-writer',
              status: 'active',
              timestamp: '2026-07-23T00:00:00.000Z',
              topic: 'unreviewed',
              trust: 'approved',
            },
            uri,
          },
        ],
      },
    );

    expect(sections.ranked[0]?.rankSignals?.authority).toBeCloseTo(0.6);
  });

  it('keeps indexed and exact results inside an explicitly pinned URI scope', () => {
    const sections = buildRecallSections(
      [],
      [
        {terms: ['alpha-42'], uri: 'threadnote://resources/repos/other/alpha-42.md'},
        {terms: ['alpha-42'], uri: 'threadnote://resources/repos/threadnote/alpha-42.md'},
      ],
      12,
      {
        allowedUriScopes: ['threadnote://resources/repos/threadnote'],
        indexedCandidates: [
          {
            fields: {identifiers: ['alpha-42']},
            text: 'alpha-42',
            uri: 'threadnote://resources/repos/other/alpha-42.md',
          },
          {
            fields: {identifiers: ['alpha-42']},
            text: 'alpha-42',
            uri: 'threadnote://resources/repos/threadnote/alpha-42.md',
          },
        ],
        query: 'alpha-42',
      },
    );

    expect(EffectArray.map(sections.ranked, hit => hit.uri)).toEqual([
      'threadnote://resources/repos/threadnote/alpha-42.md',
    ]);
    expect(sections.exactTail).toBeUndefined();
  });

  it('applies the configured minimum hybrid score to returned results', () => {
    const sections = buildRecallSections(
      [
        [
          {
            category: 'memories',
            contextType: 'memory',
            score: 0.2,
            snippet: 'weak alpha match',
            uri: 'threadnote://user/me/memories/weak.md',
          },
        ],
      ],
      [],
      12,
      {minimumScore: 0.95, query: 'alpha'},
    );

    expect(sections.ranked).toEqual([]);
    expect(sections.confidence?.level).toBe('no_answer');
  });

  it('filters hybrid results to a local-AI-selected URI allowlist', () => {
    const selectedUri = 'threadnote://user/me/memories/durable/projects/orion-worker/lease.md';
    const sections = buildRecallSections([], [], 12, {
      candidateUris: [selectedUri],
      indexedCandidates: [
        {
          fields: {project: 'orion-worker', title: 'Worker lease', topic: 'worker-lease'},
          text: 'worker lease renewal failures',
          uri: selectedUri,
        },
        {
          fields: {project: 'orion-worker', title: 'Worker metrics', topic: 'worker-metrics'},
          text: 'worker lease telemetry setting',
          uri: 'threadnote://user/me/memories/durable/projects/orion-worker/metrics.md',
        },
      ],
      project: 'orion-worker',
      query: 'worker lease renewal',
    });

    expect(EffectArray.map(sections.ranked, hit => hit.uri)).toEqual([selectedUri]);
  });

  it('does not rank an indexed memory URI that is absent from provided records', () => {
    const liveUri = 'threadnote://user/me/memories/durable/projects/threadnote/live-ranked-gate.md';
    const ghostUri = 'threadnote://user/me/memories/durable/projects/threadnote/ghost-ranked-gate.md';
    const resourceUri = 'threadnote://resources/repos/threadnote/ranked-live-gate.md';
    const sections = buildRecallSections([], [], 12, {
      indexedCandidates: [
        {
          fields: {identifiers: ['ranked-live-gate'], project: 'threadnote', title: 'Live', topic: 'live-ranked-gate'},
          text: 'ranked-live-gate live memory body',
          uri: liveUri,
        },
        {
          fields: {
            identifiers: ['ranked-live-gate'],
            project: 'threadnote',
            title: 'Ghost',
            topic: 'ghost-ranked-gate',
          },
          text: 'ranked-live-gate ghost memory body',
          uri: ghostUri,
        },
        {
          fields: {identifiers: ['ranked-live-gate'], project: 'threadnote', title: 'Resource', topic: 'resource-gate'},
          text: 'ranked-live-gate resource body',
          uri: resourceUri,
        },
      ],
      query: 'ranked-live-gate',
      records: [rankingMemoryRecord(liveUri, 'ranked-live-gate live memory body')],
    });

    expect(EffectArray.map(sections.ranked, hit => hit.uri)).toContain(liveUri);
    expect(EffectArray.map(sections.ranked, hit => hit.uri)).not.toContain(ghostUri);
    expect(EffectArray.map(sections.ranked, hit => hit.uri)).toContain(resourceUri);
  });

  it('keeps indexed memory URIs when records is an empty array rather than a loaded set', () => {
    const liveUri = 'threadnote://user/me/memories/durable/projects/threadnote/live-ranked-gate.md';
    const ghostUri = 'threadnote://user/me/memories/durable/projects/threadnote/ghost-ranked-gate.md';
    const indexedCandidates = [
      {
        fields: {identifiers: ['ranked-live-gate'], project: 'threadnote', title: 'Live', topic: 'live-ranked-gate'},
        text: 'ranked-live-gate live memory body',
        uri: liveUri,
      },
      {
        fields: {identifiers: ['ranked-live-gate'], project: 'threadnote', title: 'Ghost', topic: 'ghost-ranked-gate'},
        text: 'ranked-live-gate ghost memory body',
        uri: ghostUri,
      },
    ];
    const ranking = {indexedCandidates, query: 'ranked-live-gate'};
    const unchecked = buildRecallSections([], [], 12, ranking);
    const emptyHydration = buildRecallSections([], [], 12, {...ranking, records: []});
    const loadedMissing = buildRecallSections([], [], 12, {
      ...ranking,
      records: [rankingMemoryRecord(liveUri, 'ranked-live-gate live memory body')],
    });

    expect(EffectArray.map(emptyHydration.ranked, hit => hit.uri)).toEqual(
      EffectArray.map(unchecked.ranked, hit => hit.uri),
    );
    expect(EffectArray.map(emptyHydration.ranked, hit => hit.uri)).toEqual(expect.arrayContaining([liveUri, ghostUri]));
    expect(EffectArray.map(loadedMissing.ranked, hit => hit.uri)).toContain(liveUri);
    expect(EffectArray.map(loadedMissing.ranked, hit => hit.uri)).not.toContain(ghostUri);
  });

  it('drops extra-hydration misses even when records is an empty array', () => {
    const liveUri = 'threadnote://user/me/memories/durable/projects/threadnote/live-ranked-gate.md';
    const ghostUri = 'threadnote://user/me/memories/durable/projects/threadnote/ghost-ranked-gate.md';
    const indexedCandidates = [
      {
        fields: {identifiers: ['ranked-live-gate'], project: 'threadnote', title: 'Live', topic: 'live-ranked-gate'},
        text: 'ranked-live-gate live memory body',
        uri: liveUri,
      },
      {
        fields: {identifiers: ['ranked-live-gate'], project: 'threadnote', title: 'Ghost', topic: 'ghost-ranked-gate'},
        text: 'ranked-live-gate ghost memory body',
        uri: ghostUri,
      },
    ];
    const sections = buildRecallSections([], [], 12, {
      absentMemoryUris: [ghostUri],
      indexedCandidates,
      query: 'ranked-live-gate',
      records: [],
    });

    expect(EffectArray.map(sections.ranked, hit => hit.uri)).toContain(liveUri);
    expect(EffectArray.map(sections.ranked, hit => hit.uri)).not.toContain(ghostUri);
  });

  it('never ranks extra-hydration misses even when records is empty', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 5}), flags => {
        const candidates = EffectArray.map(flags, (_live, index) => ({
          fields: {
            identifiers: [`ranked-live-gate-${index}`],
            project: 'threadnote',
            title: `Candidate ${index}`,
            topic: `candidate-${index}`,
          },
          text: `ranked-live-gate candidate ${index}`,
          uri: `threadnote://user/me/memories/durable/projects/threadnote/ranked-gate-${index}.md`,
        }));
        const absentMemoryUris = EffectArray.flatMap(flags, (live, index) => (live ? [] : [candidates[index].uri]));
        const sections = buildRecallSections([], [], 12, {
          absentMemoryUris,
          indexedCandidates: candidates,
          query: 'ranked-live-gate',
          records: [],
        });
        const rankedMemories = EffectArray.filter(
          EffectArray.map(sections.ranked, hit => hit.uri),
          uri => Effect2.pipe(uri, EffectString.includes('/memories/')),
        );
        expect(EffectArray.every(rankedMemories, uri => !absentMemoryUris.includes(uri))).toBe(true);
      }),
    );
  });

  it('ranks only live memory URIs when a non-empty record set is provided', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 5}), flags => {
        const candidates = EffectArray.map(flags, (_live, index) => ({
          fields: {
            identifiers: [`ranked-live-gate-${index}`],
            project: 'threadnote',
            title: `Candidate ${index}`,
            topic: `candidate-${index}`,
          },
          text: `ranked-live-gate candidate ${index}`,
          uri: `threadnote://user/me/memories/durable/projects/threadnote/ranked-gate-${index}.md`,
        }));
        const records = EffectArray.flatMap(flags, (live, index) =>
          live ? [rankingMemoryRecord(candidates[index].uri, candidates[index].text)] : [],
        );
        const sections = buildRecallSections([], [], 12, {
          indexedCandidates: candidates,
          query: 'ranked-live-gate',
          records,
        });
        const rankedMemories = EffectArray.filter(
          EffectArray.map(sections.ranked, hit => hit.uri),
          uri => Effect2.pipe(uri, EffectString.includes('/memories/')),
        );
        if (records.length === 0) {
          const unchecked = buildRecallSections([], [], 12, {
            indexedCandidates: candidates,
            query: 'ranked-live-gate',
          });
          expect(rankedMemories).toEqual(
            EffectArray.filter(
              EffectArray.map(unchecked.ranked, hit => hit.uri),
              uri => Effect2.pipe(uri, EffectString.includes('/memories/')),
            ),
          );
          return;
        }
        const liveUris = new Set(EffectArray.map(records, record => record.uri));
        expect(EffectArray.every(rankedMemories, uri => liveUris.has(uri))).toBe(true);
      }),
    );
  });

  it('bounds full hybrid ranking of lexical index matches before graph and BM25 work', () => {
    const indexedCandidates = Array.from({length: 250}, (_unused, index) => ({
      fields: {identifiers: ['alpha-42']},
      text: `alpha-42 candidate ${index}`,
      uri: `threadnote://resources/repos/threadnote/${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
    }));

    const sections = buildRecallSections([], [], 3, {
      indexedCandidates,
      query: 'alpha-42',
    });

    expect(sections.ranked.length).toBeLessThanOrEqual(100);
    expect(sections.ranked.length).toBeGreaterThan(0);
  });

  it('leads with a low-confidence note when the window is entirely keyword-only', () => {
    // No semantic pass matched; every shown hit is a promoted exact-only doc.
    const {semanticSection} = buildRecallSections(
      [],
      [{terms: ['kubernetes'], uri: 'threadnote://user/me/memories/durable/projects/x/unrelated.md'}],
      12,
    );
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native split indexing preserves the first-line assertion.
    expect(semanticSection?.split('\n')[0]).toBe(RECALL_LOW_CONFIDENCE_NOTE);
    expect(semanticSection).toContain('keyword-only: kubernetes');
  });

  it('omits the low-confidence note when a semantic hit is present', () => {
    const {semanticSection} = buildRecallSections(
      [
        parseRecallHits(
          json({ok: true, result: {memories: [{uri: 'threadnote://real.md', score: 0.7, abstract: 'x'}]}}),
        ),
      ],
      [{terms: ['kubernetes'], uri: 'threadnote://user/me/memories/durable/projects/x/unrelated.md'}],
      12,
    );
    expect(semanticSection).not.toContain(RECALL_LOW_CONFIDENCE_NOTE);
    // Positively assert the mixed state so the test cannot pass by dropping the
    // semantic hit or rendering an empty section.
    expect(semanticSection).toContain('threadnote://real.md');
    expect(semanticSection).toContain('keyword-only: kubernetes');
  });

  it('emits no note and no section for an empty result', () => {
    const {semanticSection} = buildRecallSections([], [], 12);
    expect(semanticSection).toBeUndefined();
  });

  it('omits archived lifecycle memories by default', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {
              context_type: 'memory',
              uri: 'threadnote://user/denys/memories/handoffs/archived/threadnote/old.md#chunk_0000',
              score: 0.8,
              abstract: 'old',
            },
            {
              context_type: 'memory',
              uri: 'threadnote://user/denys/memories/durable/projects/threadnote/current.md',
              score: 0.7,
              abstract: 'current',
            },
          ],
        },
      }),
    );

    expect(EffectArray.map(hits, hit => hit.uri)).toEqual([
      'threadnote://user/denys/memories/durable/projects/threadnote/current.md',
    ]);
  });

  it('keeps archived lifecycle memories when includeArchived is set', () => {
    const hits = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {
              context_type: 'memory',
              uri: 'threadnote://user/denys/memories/durable/archived/threadnote/old.md',
              score: 0.8,
              abstract: 'old',
            },
          ],
        },
      }),
      {includeArchived: true},
    );

    expect(EffectArray.map(hits, hit => hit.uri)).toEqual([
      'threadnote://user/denys/memories/durable/archived/threadnote/old.md',
    ]);
  });

  it('merges passes, collapses chunks to one document, keeps the best score, ranks desc', () => {
    const base = parseRecallHits(
      json({ok: true, result: {memories: [{uri: 'threadnote://doc.md#chunk_0000', score: 0.5, abstract: 'x'}]}}),
    );
    const scoped = parseRecallHits(
      json({
        ok: true,
        result: {
          memories: [
            {uri: 'threadnote://doc.md#chunk_0009', score: 0.8, abstract: 'y'},
            {uri: 'threadnote://other.md', score: 0.6, abstract: 'z'},
          ],
        },
      }),
    );
    const merged = mergeRecallHits([base, scoped]);
    expect(EffectArray.map(merged, hit => ({score: hit.score, uri: hit.uri}))).toEqual([
      {score: 0.8, uri: 'threadnote://doc.md'},
      {score: 0.6, uri: 'threadnote://other.md'},
    ]);
  });

  it('ranks memories above resources and skills regardless of score', () => {
    const merged = mergeRecallHits([
      parseRecallHits(
        json({
          ok: true,
          result: {
            memories: [{context_type: 'memory', uri: 'threadnote://mem.md', score: 0.5, abstract: 'm'}],
            resources: [{context_type: 'resource', uri: 'threadnote://res.md', score: 0.9, abstract: 'r'}],
            skills: [{context_type: 'skill', uri: 'threadnote://skill.md', score: 0.8, abstract: 's'}],
          },
        }),
      ),
    ]);
    expect(EffectArray.map(merged, hit => hit.uri)).toEqual([
      'threadnote://mem.md',
      'threadnote://res.md',
      'threadnote://skill.md',
    ]);
  });

  it('formats a capped numbered list with overflow note', () => {
    const hits = Array.from({length: 4}, (_unused, index) => ({
      category: 'memories' as const,
      contextType: 'memory',
      score: 0.5,
      snippet: '',
      uri: `threadnote://m${index}.md`,
    }));
    const text = formatRecallHits(hits, 2) ?? '';
    expect(text).toContain('1. memory · score 0.50 · threadnote://m0.md');
    expect(text).toContain('(+2 more');
    expect(formatRecallHits([], 5)).toBeUndefined();
  });

  it('collapses resource hits with identical snippets but keeps distinct memories', () => {
    const {ranked} = buildRecallSections(
      [
        parseRecallHits(
          json({
            ok: true,
            result: {
              resources: [
                {
                  context_type: 'resource',
                  uri: 'threadnote://r/.agents/skills/x/SKILL.md',
                  score: 0.7,
                  abstract: 'same',
                },
                {
                  context_type: 'resource',
                  uri: 'threadnote://r/.claude/skills/x/SKILL.md',
                  score: 0.6,
                  abstract: 'same',
                },
              ],
              memories: [
                {context_type: 'memory', uri: 'threadnote://m1.md', score: 0.8, abstract: 'dup'},
                {context_type: 'memory', uri: 'threadnote://m2.md', score: 0.75, abstract: 'dup'},
              ],
            },
          }),
        ),
      ],
      [],
      12,
    );
    // One resource kept (highest score), both memories kept despite identical snippet.
    expect(EffectArray.map(ranked, hit => hit.uri)).toEqual([
      'threadnote://m1.md',
      'threadnote://m2.md',
      'threadnote://r/.agents/skills/x/SKILL.md',
    ]);
  });

  it('does not collapse resource hits with empty snippets', () => {
    const {ranked} = buildRecallSections(
      [
        parseRecallHits(
          json({
            ok: true,
            result: {
              resources: [
                {context_type: 'resource', uri: 'threadnote://r/a.md', score: 0.7, abstract: ''},
                {context_type: 'resource', uri: 'threadnote://r/b.md', score: 0.6, abstract: ''},
              ],
            },
          }),
        ),
      ],
      [],
      12,
    );
    expect(EffectArray.map(ranked, hit => hit.uri)).toEqual(['threadnote://r/a.md', 'threadnote://r/b.md']);
  });

  it('keeps the exact-matched twin when a content-duplicate would otherwise be dropped', () => {
    // Lower-scored .claude copy is the exact match; it must survive dedup and lead.
    const {ranked} = buildRecallSections(
      [
        parseRecallHits(
          json({
            ok: true,
            result: {
              resources: [
                {
                  context_type: 'resource',
                  uri: 'threadnote://r/.agents/skills/x/SKILL.md',
                  score: 0.7,
                  abstract: 'same',
                },
                {
                  context_type: 'resource',
                  uri: 'threadnote://r/.claude/skills/x/SKILL.md',
                  score: 0.6,
                  abstract: 'same',
                },
              ],
            },
          }),
        ),
      ],
      [{terms: ['chaos'], uri: 'threadnote://r/.claude/skills/x/SKILL.md'}],
      12,
    );
    expect(EffectArray.map(ranked, hit => hit.uri)).toEqual(['threadnote://r/.claude/skills/x/SKILL.md']);
  });

  it('builds an exact tail that excludes matches already shown in the ranked window', () => {
    const sections = buildRecallSections(
      [
        parseRecallHits(
          json({ok: true, result: {memories: [{uri: 'threadnote://shown.md', score: 0.8, abstract: 'x'}]}}),
        ),
      ],
      [
        {terms: ['a'], uri: 'threadnote://shown.md'},
        {terms: ['a'], uri: 'threadnote://resources/repos/coda/only-exact.md'},
      ],
      12,
    );
    // shown.md is in the ranked window, so it is filtered out of the tail; the
    // exact-only doc was promoted into the window too, so the tail is empty.
    expect(sections.exactTail).toBeUndefined();
    expect(EffectArray.map(sections.ranked, hit => hit.uri)).toContain(
      'threadnote://resources/repos/coda/only-exact.md',
    );
  });
});

describe('buildRecallSections per-category reserve', () => {
  const mk = (category: 'memories' | 'resources' | 'skills', index: number, score: number): RecallHit => ({
    category,
    contextType: category === 'memories' ? 'memory' : category === 'skills' ? 'skill' : 'resource',
    score,
    snippet: '',
    uri: `threadnote://${category}/${index}`,
  });
  const numberedLines = (section: string | undefined): number =>
    EffectArray.filter(
      Effect2.pipe(section ?? '', EffectString.split('\n')),
      __effectArrayValue2 => !!(line => /^\d+\. /.test(line))(__effectArrayValue2),
    ).length;

  it('reserves window slots for resources and skills in a memory-heavy result', () => {
    const hits = [
      ...Array.from({length: 12}, (_unused, i) => mk('memories', i, 0.9 - i * 0.01)),
      ...Array.from({length: 3}, (_unused, i) => mk('resources', i, 0.5 - i * 0.01)),
      ...Array.from({length: 2}, (_unused, i) => mk('skills', i, 0.4 - i * 0.01)),
    ];
    const {semanticSection} = buildRecallSections([hits], [], 12);
    const text = semanticSection ?? '';
    // RECALL_CATEGORY_RESERVE = 2 → two resources and two skills are guaranteed visibility.
    expect(text).toContain('threadnote://resources/0');
    expect(text).toContain('threadnote://resources/1');
    expect(text).not.toContain('threadnote://resources/2');
    expect(text).toContain('threadnote://skills/0');
    expect(text).toContain('threadnote://skills/1');
    // Memories still take every remaining slot: 12 - 2 - 2 = 8.
    expect(
      (
        Effect2.pipe(
          text,
          EffectString.match(/threadnote:\/\/memories\//g),
          Effect2.Option.getOrElse(() => null),
        ) ?? []
      ).length,
    ).toBe(8);
    // Display stays fully category-first: every memory precedes every resource,
    // which precedes every skill.
    const lines = EffectArray.filter(
      Effect2.pipe(text, EffectString.split('\n')),
      __effectArrayValue2 => !!(line => /^\d+\. /.test(line))(__effectArrayValue2),
    );
    const lastMemory = EffectArray.map(lines, l => Effect2.pipe(l, EffectString.includes('memories/'))).lastIndexOf(
      true,
    );
    const firstResource = EffectOption.getOrElse(
      EffectArray.findFirstIndex(
        lines,
        __effectArrayValue => !!(l => Effect2.pipe(l, EffectString.includes('resources/')))(__effectArrayValue),
      ),
      () => -1,
    );
    const lastResource = EffectArray.map(lines, l => Effect2.pipe(l, EffectString.includes('resources/'))).lastIndexOf(
      true,
    );
    const firstSkill = EffectOption.getOrElse(
      EffectArray.findFirstIndex(
        lines,
        __effectArrayValue => !!(l => Effect2.pipe(l, EffectString.includes('skills/')))(__effectArrayValue),
      ),
      () => -1,
    );
    expect(firstResource).toBeGreaterThan(lastMemory);
    expect(firstSkill).toBeGreaterThan(lastResource);
    expect(numberedLines(semanticSection)).toBe(12);
  });

  it('shows every hit in category-first order when the result fits the window', () => {
    const hits = [mk('skills', 0, 0.4), mk('memories', 0, 0.9), mk('resources', 0, 0.5)];
    const {semanticSection} = buildRecallSections([hits], [], 12);
    const lines = EffectArray.filter(
      Effect2.pipe(semanticSection ?? '', EffectString.split('\n')),
      __effectArrayValue2 => !!(line => /^\d+\. /.test(line))(__effectArrayValue2),
    );
    expect(EffectArray.map(lines, l => Effect2.pipe(l, EffectString.replace(/^\d+\. .* · /, '')))).toEqual([
      'threadnote://memories/0',
      'threadnote://resources/0',
      'threadnote://skills/0',
    ]);
  });

  it('applies the reserve best-effort by priority when the window is smaller than reserve x categories', () => {
    // limit 4 < RECALL_CATEGORY_RESERVE (2) * 3 categories: the two higher-priority
    // categories claim their reserve first, and the lowest (skills) is squeezed out.
    const hits = [
      ...Array.from({length: 2}, (_unused, i) => mk('memories', i, 0.9 - i * 0.01)),
      ...Array.from({length: 2}, (_unused, i) => mk('resources', i, 0.5 - i * 0.01)),
      ...Array.from({length: 2}, (_unused, i) => mk('skills', i, 0.4 - i * 0.01)),
    ];
    const text = buildRecallSections([hits], [], 4).semanticSection ?? '';
    expect(numberedLines(text)).toBe(4);
    expect(text).toContain('threadnote://memories/0');
    expect(text).toContain('threadnote://memories/1');
    expect(text).toContain('threadnote://resources/0');
    expect(text).toContain('threadnote://resources/1');
    expect(text).not.toContain('threadnote://skills/');
  });

  it('does not starve a memory-only result of slots', () => {
    const hits = Array.from({length: 15}, (_unused, i) => mk('memories', i, 0.9 - i * 0.01));
    const {semanticSection} = buildRecallSections([hits], [], 12);
    expect(numberedLines(semanticSection)).toBe(12);
    expect(
      Effect2.pipe(
        semanticSection ?? '',
        EffectString.match(/threadnote:\/\/memories\//g),
        Effect2.Option.getOrElse(() => null),
      )?.length,
    ).toBe(12);
  });
});

describe('categoryForUri', () => {
  it('classifies memories, skill catalog, and resources', () => {
    expect(categoryForUri('threadnote://user/me/memories/durable/projects/x/y.md')).toBe('memories');
    expect(categoryForUri('threadnote://user/me/memories/shared/default/durable/x.md')).toBe('memories');
    expect(categoryForUri('threadnote://resources/agent-skills/codex-global/foo/SKILL.md')).toBe('skills');
    expect(categoryForUri('threadnote://resources/repos/coda/CLAUDE.md')).toBe('resources');
    expect(categoryForUri('threadnote://resources/repos/coda/.claude/skills/x/SKILL.md')).toBe('resources');
  });

  it('keeps shared agent artifacts out of the memory band (routes them to skills)', () => {
    expect(
      categoryForUri('threadnote://user/me/memories/shared/default/agent-artifacts/skills/claude/reviewer/SKILL.md'),
    ).toBe('skills');
  });
});

describe('memoryUriProjectSegment', () => {
  const u = (path: string): string => `threadnote://user/me/memories/${path}`;
  it('extracts the project for personal durable/handoff/incident memories', () => {
    expect(memoryUriProjectSegment(u('durable/projects/mobile-native/auth.md'))).toBe('mobile-native');
    expect(memoryUriProjectSegment(u('durable/archived/mobile-native/auth.md'))).toBe('mobile-native');
    expect(memoryUriProjectSegment(u('handoffs/active/threadnote/foo.md'))).toBe('threadnote');
    expect(memoryUriProjectSegment(u('incidents/active/coda/bar.md'))).toBe('coda');
  });

  it('de-scopes shared team memories to the underlying project', () => {
    expect(memoryUriProjectSegment(u('shared/docs-desktop/durable/projects/coda/pagerduty.md'))).toBe('coda');
  });

  it('returns undefined for project-less kinds, directory nodes, and non-memory URIs', () => {
    expect(memoryUriProjectSegment(u('preferences/coding-style.md'))).toBeUndefined();
    expect(memoryUriProjectSegment(u('preferences/archived/old.md'))).toBeUndefined();
    expect(memoryUriProjectSegment(u('smoke/active/probe.md'))).toBeUndefined();
    expect(memoryUriProjectSegment(u('durable/projects/mobile-native'))).toBeUndefined(); // dir node, no file
    expect(memoryUriProjectSegment('threadnote://resources/repos/coda/README.md')).toBeUndefined();
  });

  it('ignores a chunk anchor', () => {
    expect(memoryUriProjectSegment(u('durable/projects/coda/x.md#chunk_0001'))).toBe('coda');
  });
});

describe('memoryFrontmatterField', () => {
  const doc = EffectArray.join(
    ['MEMORY', 'kind: durable', 'status: active', 'project: mobile-native', 'topic: auth', '', 'Body.'],
    '\n',
  );
  it('reads a header field from the leading block', () => {
    expect(memoryFrontmatterField(doc, 'project')).toBe('mobile-native');
    expect(memoryFrontmatterField(doc, 'topic')).toBe('auth');
  });
  it('returns undefined for an absent field and does not read the body', () => {
    expect(memoryFrontmatterField(doc, 'repo')).toBeUndefined();
    expect(memoryFrontmatterField('MEMORY\nkind: durable\n\nproject: not-a-header', 'project')).toBeUndefined();
  });

  it('treats a bare (empty-value) field as absent', () => {
    expect(memoryFrontmatterField('MEMORY\nkind: durable\nproject:\ntopic: t\n\nb', 'project')).toBeUndefined();
    expect(memoryFrontmatterField('MEMORY\nproject:   \n\nb', 'project')).toBeUndefined();
  });

  it('does not match a field that is only a prefix of another key', () => {
    expect(memoryFrontmatterField('MEMORY\nproject_id: coda\n\nb', 'project')).toBeUndefined();
  });

  it('trims a trailing-whitespace value (memories round-trip through git)', () => {
    expect(memoryFrontmatterField('MEMORY\nproject: coda   \n\nb', 'project')).toBe('coda');
  });
});

describe('isAgentArtifactPackUri', () => {
  it('flags pack machinery but not shared skills or plain memories', () => {
    expect(
      isAgentArtifactPackUri(
        'threadnote://user/me/memories/shared/default/agent-artifacts/packs/claude/reviewer/reviewer.pack.json',
      ),
    ).toBe(true);
    expect(
      isAgentArtifactPackUri(
        'threadnote://user/me/memories/shared/default/agent-artifacts/packs/claude/reviewer/files/prompts/f.md',
      ),
    ).toBe(true);
    expect(
      isAgentArtifactPackUri(
        'threadnote://user/me/memories/shared/default/agent-artifacts/skills/claude/reviewer/SKILL.md',
      ),
    ).toBe(false);
    expect(isAgentArtifactPackUri('threadnote://user/me/memories/durable/projects/x/y.md')).toBe(false);
  });
});

describe('applyExactMatchBoost', () => {
  const hit = (over: Partial<RecallHit> = {}): RecallHit => ({
    category: 'resources',
    contextType: 'resource',
    score: 0.6,
    snippet: 's',
    uri: 'threadnote://x',
    ...over,
  });

  it('returns hits unchanged when there are no exact matches', () => {
    const hits = [hit()];
    expect(applyExactMatchBoost(hits, [])).toBe(hits);
  });

  it('annotates a semantic hit that an exact term also matched', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'threadnote://a', score: 0.6}), hit({uri: 'threadnote://b', score: 0.9})],
      [{terms: ['release', 'test'], uri: 'threadnote://a'}],
    );
    const a = EffectOption.getOrUndefined(EffectArray.findFirst(ranked, entry => entry.uri === 'threadnote://a'));
    expect(a?.exactTerms).toEqual(['release', 'test']);
    // Exact match leads its category despite lower semantic score.
    expect(ranked[0]?.uri).toBe('threadnote://a');
  });

  it('promotes an exact-only document into the ranked list with score 0', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'threadnote://sem', score: 0.9})],
      [{terms: ['conventions'], uri: 'threadnote://resources/repos/coda/CLAUDE.md'}],
    );
    const promoted = EffectOption.getOrUndefined(
      EffectArray.findFirst(ranked, entry => entry.uri === 'threadnote://resources/repos/coda/CLAUDE.md'),
    );
    expect(promoted).toMatchObject({
      category: 'resources',
      contextType: 'resource',
      score: 0,
      exactTerms: ['conventions'],
    });
    // Promoted exact match outranks the unmatched higher-scoring semantic hit in the same category.
    expect(ranked[0]?.uri).toBe('threadnote://resources/repos/coda/CLAUDE.md');
  });

  it('orders by category, then blended exact strength + score', () => {
    const ranked = applyExactMatchBoost(
      [
        hit({category: 'memories', contextType: 'memory', uri: 'threadnote://user/me/memories/m.md', score: 0.5}),
        hit({uri: 'threadnote://r-one-term', score: 0.6}),
        hit({uri: 'threadnote://r-two-terms', score: 0.55}),
      ],
      [
        {terms: ['a'], uri: 'threadnote://r-one-term'},
        {terms: ['a', 'b'], uri: 'threadnote://r-two-terms'},
      ],
    );
    expect(EffectArray.map(ranked, entry => entry.uri)).toEqual([
      'threadnote://user/me/memories/m.md',
      'threadnote://r-two-terms',
      'threadnote://r-one-term',
    ]);
  });

  it('breaks ties by score when exact strength is equal', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'threadnote://lo', score: 0.5}), hit({uri: 'threadnote://hi', score: 0.8})],
      [
        {terms: ['a'], uri: 'threadnote://lo'},
        {terms: ['a'], uri: 'threadnote://hi'},
      ],
    );
    // Same single-term match → higher semantic score wins.
    expect(EffectArray.map(ranked, entry => entry.uri)).toEqual(['threadnote://hi', 'threadnote://lo']);
  });

  it('renders promoted exact-only hits without a score and annotates boosted hits', () => {
    const ranked = applyExactMatchBoost(
      [hit({uri: 'threadnote://sem', score: 0.62})],
      [
        {terms: ['x'], uri: 'threadnote://sem'},
        {terms: ['y', 'z'], uri: 'threadnote://resources/repos/coda/CLAUDE.md'},
      ],
    );
    const lines = Effect2.pipe(formatRecallHits(ranked, 5) ?? '', EffectString.split('\n'));
    const promotedIndex = EffectOption.getOrElse(
      EffectArray.findFirstIndex(
        lines,
        __effectArrayValue => !!(line => Effect2.pipe(line, EffectString.includes('CLAUDE.md')))(__effectArrayValue),
      ),
      () => -1,
    );
    // Promoted exact-only line is labelled keyword-only (no semantic match),
    // carries no "score" token, and is not followed by a wrapped (3-space
    // indented) snippet line, since its snippet is empty.
    expect(lines[promotedIndex]).toContain(
      'resource · keyword-only: y, z · threadnote://resources/repos/coda/CLAUDE.md',
    );
    expect(lines[promotedIndex]).not.toContain('score');
    expect(lines[promotedIndex + 1] ?? '').not.toMatch(/^ {3}/);
    // A semantic hit that a term also matched keeps the "exact:" label.
    expect(EffectArray.join(lines, '\n')).toContain('resource · score 0.62 · exact: x · threadnote://sem');
  });

  it('weights a rare exact term above a common one (inverse document frequency)', () => {
    // "common" matches three documents, "rare" matches one. The rare-term
    // document leads even though "common" appears in more of the result set.
    const ranked = applyExactMatchBoost(
      [],
      [
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/c1.md'},
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/c2.md'},
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/c3.md'},
        {terms: ['rare'], uri: 'threadnote://user/me/memories/durable/projects/x/r.md'},
      ],
    );
    expect(ranked[0]?.uri).toBe('threadnote://user/me/memories/durable/projects/x/r.md');
  });

  it('boosts an exact term that names the document slug over a body-only match', () => {
    // Same term, same document frequency — the memory whose topic slug names the
    // term wins over one that only mentions it in the body (an incidental match).
    const ranked = applyExactMatchBoost(
      [],
      [
        {
          terms: ['observability'],
          uri: 'threadnote://user/me/memories/durable/projects/x/mobile-observability-spec.md',
        },
        {terms: ['observability'], uri: 'threadnote://user/me/memories/durable/projects/x/desktop-layout-review.md'},
      ],
    );
    expect(ranked[0]?.uri).toContain('mobile-observability-spec');
  });

  it('gives the slug bonus only on a token boundary, not an incidental substring', () => {
    // "spec" names the slug token in one doc but is only a substring of "respec"
    // in the other; same term and df, so the whole-token match must win.
    const ranked = applyExactMatchBoost(
      [],
      [
        {terms: ['spec'], uri: 'threadnote://user/me/memories/durable/projects/x/mobile-alerting-spec.md'},
        {terms: ['spec'], uri: 'threadnote://user/me/memories/durable/projects/x/design-respec-notes.md'},
      ],
    );
    expect(ranked[0]?.uri).toContain('mobile-alerting-spec');
    expect(ranked[1]?.uri).toContain('design-respec-notes');
  });

  it('keeps a common-word-only promotion below a genuine semantic hit', () => {
    // The semantic hit carries no exact term but scores 0.6; the promoted docs
    // match only a corpus-common term (df 5 → strength 0.2), so they no longer
    // outrank the real semantic hit — this is the anti-flooding guarantee.
    const ranked = applyExactMatchBoost(
      [
        hit({
          category: 'memories',
          contextType: 'memory',
          uri: 'threadnote://user/me/memories/semantic.md',
          score: 0.6,
        }),
      ],
      [
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/p1.md'},
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/p2.md'},
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/p3.md'},
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/p4.md'},
        {terms: ['common'], uri: 'threadnote://user/me/memories/durable/projects/x/p5.md'},
      ],
    );
    expect(ranked[0]?.uri).toBe('threadnote://user/me/memories/semantic.md');
  });
});
