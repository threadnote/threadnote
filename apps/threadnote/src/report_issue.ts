import {Array as EffectArray} from 'effect';
import {Console, Effect, FileSystem, Schema} from 'effect';
import {applyScrubber, type ScrubberResult} from '@threadnote/platform/scrubber';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {CommandFailed, CommandSpawnFailed, runCommandEffect} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {productionLogSupportExcerpt, type ProductionLogSupportExcerpt} from './effect/production_log.js';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const THREADNOTE_GITHUB_REPOSITORY = 'threadnote/threadnote';
const THREADNOTE_GITHUB_ISSUES_ENDPOINT = `repos/${THREADNOTE_GITHUB_REPOSITORY}/issues`;
const THREADNOTE_GITHUB_ISSUE_URL_PREFIX = `https://github.com/${THREADNOTE_GITHUB_REPOSITORY}/issues/`;
const REPORT_ISSUE_TITLE_MAX_CHARACTERS = 200;
const REPORT_ISSUE_DESCRIPTION_MAX_CHARACTERS = 20_000;
const REPORT_ISSUE_LOG_MAX_CHARACTERS = 35_000;
const REPORT_ISSUE_BODY_MAX_CHARACTERS = 60_000;
const REPORT_ISSUE_COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const REPORT_ISSUE_COMMAND_OUTPUT_MAX_BYTES = 16 * 1024;
const REPORT_ISSUE_REQUEST_FILE_MODE = 0o600;
const REPORT_ISSUE_APPROVAL_PREFIX = 'sha256:';
const CHARACTER_CODE_HORIZONTAL_TAB = 9;
const CHARACTER_CODE_LINE_FEED = 10;
const CHARACTER_CODE_C0_CONTROL_END = 31;
const CHARACTER_CODE_C1_CONTROL_START = 127;
const CHARACTER_CODE_C1_CONTROL_END = 159;

export interface ReportIssueOptions {
  readonly approval?: string;
  readonly apply: boolean;
  readonly body: string;
  readonly includeLogs: boolean;
  readonly title: string;
}

interface PreparedIssue {
  readonly approval: string;
  readonly body: string;
  readonly logExcerpt?: ProductionLogSupportExcerpt;
  readonly redactions: readonly {readonly count: number; readonly name: string}[];
  readonly title: string;
}

export class ReportIssueInvalid extends Schema.TaggedError<ReportIssueInvalid, {readonly brand: unique symbol}>()(
  'ReportIssueInvalid',
  {
    message: Schema.String,
  },
) {}

export class ReportIssueCreateFailed extends Schema.TaggedError<
  ReportIssueCreateFailed,
  {readonly brand: unique symbol}
>()('ReportIssueCreateFailed', {
  message: Schema.String,
}) {}

export const runReportIssue = Effect.fn('reportIssue.runReportIssue')(function* (
  config: RuntimeConfig,
  options: ReportIssueOptions,
) {
  const issue = yield* prepareReportIssue(config, options);
  yield* printReportIssuePreview(issue);
  if (!options.apply) {
    yield* Console.log(
      'Submission requires GitHub CLI from https://cli.github.com/ and an authenticated `gh auth login` session.',
    );
    yield* Console.log(
      `No issue created. Review the preview, then rerun with --apply --approval ${issue.approval} after explicit approval.`,
    );
    return;
  }
  if (options.approval !== issue.approval) {
    return yield* ReportIssueInvalid.make({
      message: `The prepared issue does not match an approved preview. Review it, then retry with --approval ${issue.approval}.`,
    });
  }
  const issueUrl = yield* createGitHubIssue(issue);
  yield* Console.log(`Created GitHub issue: ${issueUrl}`);
});

const prepareReportIssue = Effect.fn('reportIssue.prepareReportIssue')(function* (
  config: RuntimeConfig,
  options: ReportIssueOptions,
) {
  if (hasUnsafePublicControl(options.title, false) || hasUnsafePublicControl(options.body, true)) {
    return yield* ReportIssueInvalid.make({
      message: 'Issue title or body contains unsafe terminal control characters. Remove them and retry.',
    });
  }
  const titleResult = scrubPublicText(options.title);
  const bodyResult = scrubPublicText(options.body);
  if (titleResult.blocker !== undefined || bodyResult.blocker !== undefined) {
    return yield* ReportIssueInvalid.make({
      message: `Refusing to report an issue containing a possible ${titleResult.blocker ?? bodyResult.blocker}. Remove it and retry.`,
    });
  }
  const title = Effect2.pipe(titleResult.cleaned, EffectString.trim);
  const description = Effect2.pipe(bodyResult.cleaned, EffectString.trim);
  if (title.length === 0) {
    return yield* ReportIssueInvalid.make({message: 'Issue title must not be empty.'});
  }
  if (description.length === 0) {
    return yield* ReportIssueInvalid.make({message: 'Issue body must not be empty.'});
  }
  if (title.length > REPORT_ISSUE_TITLE_MAX_CHARACTERS) {
    return yield* ReportIssueInvalid.make({
      message: `Issue title must be at most ${REPORT_ISSUE_TITLE_MAX_CHARACTERS} characters.`,
    });
  }
  if (description.length > REPORT_ISSUE_DESCRIPTION_MAX_CHARACTERS) {
    return yield* ReportIssueInvalid.make({
      message: `Issue body must be at most ${REPORT_ISSUE_DESCRIPTION_MAX_CHARACTERS} characters before diagnostics.`,
    });
  }

  const system = yield* SystemInfo;
  const version = yield* getThreadnoteVersion().pipe(Effect.orElseSucceed(() => 'unknown'));
  const logExcerpt = options.includeLogs
    ? yield* productionLogSupportExcerpt(config.agentContextHome, REPORT_ISSUE_LOG_MAX_CHARACTERS)
    : undefined;
  const diagnostics = [
    '### Threadnote diagnostics',
    '',
    `- Threadnote: ${version}`,
    `- Runtime: Bun ${system.runtimeVersion}`,
    `- Platform: ${system.platform} ${system.architecture}`,
    `- Production logs included: ${options.includeLogs ? 'yes' : 'no'}`,
  ];
  if (logExcerpt !== undefined) {
    diagnostics.push(
      `- Log entries: ${logExcerpt.includedEntries} included, ${logExcerpt.omittedEntries} older omitted, ${logExcerpt.discardedEntries} invalid discarded`,
    );
    if (logExcerpt.includedEntries === 0) {
      diagnostics.push('', '_No valid Threadnote production log entries were available._');
    } else {
      diagnostics.push(
        '',
        '<details>',
        '<summary>Privacy-safe Threadnote production logs</summary>',
        '',
        '```jsonl',
        logExcerpt.content,
        '```',
        '</details>',
      );
    }
  }
  const body = `${description}\n\n---\n\n${EffectArray.join(diagnostics, '\n')}`;
  if (body.length > REPORT_ISSUE_BODY_MAX_CHARACTERS) {
    return yield* ReportIssueInvalid.make({
      message: `Prepared issue body exceeds the ${REPORT_ISSUE_BODY_MAX_CHARACTERS}-character safety limit.`,
    });
  }
  const approval = `${REPORT_ISSUE_APPROVAL_PREFIX}${yield* sha256Hex(JSON.stringify({body, title}))}`;
  return {
    approval,
    body,
    logExcerpt,
    redactions: mergeRedactions(titleResult, bodyResult),
    title,
  } satisfies PreparedIssue;
});

const printReportIssuePreview = Effect.fn('reportIssue.printReportIssuePreview')(function* (issue: PreparedIssue) {
  yield* Console.log(`GitHub issue preview: ${THREADNOTE_GITHUB_REPOSITORY}`);
  yield* Console.log(`Title: ${issue.title}`);
  yield* Console.log(`Approval digest: ${issue.approval}`);
  for (const redaction of issue.redactions) {
    yield* Console.log(`Redacted ${redaction.count} ${redaction.name} match(es) from the public report.`);
  }
  yield* Console.log('-----BEGIN ISSUE BODY-----');
  yield* Console.log(issue.body);
  yield* Console.log('-----END ISSUE BODY-----');
});

const createGitHubIssue = Effect.fn('reportIssue.createGitHubIssue')(function* (issue: PreparedIssue) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const requestPath = yield* fs.makeTempFileScoped({prefix: 'threadnote-issue-', suffix: '.json'});
      yield* fs.writeFileString(requestPath, `${JSON.stringify({body: issue.body, title: issue.title})}\n`, {
        mode: REPORT_ISSUE_REQUEST_FILE_MODE,
      });
      yield* fs.chmod(requestPath, REPORT_ISSUE_REQUEST_FILE_MODE);
      const result = yield* runCommandEffect(
        'gh',
        [
          'api',
          '--method',
          'POST',
          '--hostname',
          'github.com',
          THREADNOTE_GITHUB_ISSUES_ENDPOINT,
          '--input',
          requestPath,
          '--jq',
          '.html_url',
        ],
        {
          env: {
            ...system.environment(),
            GH_PAGER: 'cat',
            GH_PROMPT_DISABLED: '1',
            NO_COLOR: '1',
          },
          maxOutputBytes: REPORT_ISSUE_COMMAND_OUTPUT_MAX_BYTES,
          timeoutMs: REPORT_ISSUE_COMMAND_TIMEOUT_MILLISECONDS,
        },
      ).pipe(Effect.mapError(cause => reportIssueCreateFailure(cause, system.platform)));
      const issueUrl = Effect2.pipe(result.stdout, EffectString.trim);
      if (!isThreadnoteIssueUrl(issueUrl)) {
        return yield* ReportIssueCreateFailed.make({
          message: 'GitHub returned an invalid issue URL. Check the repository before retrying.',
        });
      }
      return issueUrl;
    }),
  );
});

function reportIssueCreateFailure(cause: unknown, platform: NodeJS.Platform): ReportIssueCreateFailed {
  if (Schema.is(CommandSpawnFailed)(cause)) {
    return ReportIssueCreateFailed.make({
      message: `GitHub CLI (\`gh\`) is required only for submission. ${githubCliInstallInstruction(platform)} Then run \`gh auth login\` and retry with \`--apply\`.`,
    });
  }
  if (
    Schema.is(CommandFailed)(cause) &&
    /auth|credential|login|token|HTTP 401|HTTP 403/i.test(`${cause.stderr}\n${cause.stdout}`)
  ) {
    return ReportIssueCreateFailed.make({
      message: 'GitHub authentication failed. Run `gh auth login` with permission to create issues, then retry.',
    });
  }
  return ReportIssueCreateFailed.make({
    message: 'GitHub issue creation failed through `gh api`. Check connectivity and `gh auth status`, then retry.',
  });
}

function githubCliInstallInstruction(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install it from https://cli.github.com/ or run `brew install gh`.';
    case 'win32':
      return 'Install it from https://cli.github.com/ or run `winget install --id GitHub.cli`.';
    default:
      return 'Install it using the instructions at https://cli.github.com/.';
  }
}

function scrubPublicText(content: string): ScrubberResult {
  return applyScrubber(content, {redact: true});
}

function hasUnsafePublicControl(content: string, allowFormattingWhitespace: boolean): boolean {
  for (const character of content) {
    const code = Effect2.pipe(
      character,
      EffectString.codePointAt(0),
      Effect2.Option.getOrElse(() => undefined),
    );
    if (code === undefined) {
      continue;
    }
    const allowedWhitespace =
      allowFormattingWhitespace && (code === CHARACTER_CODE_HORIZONTAL_TAB || code === CHARACTER_CODE_LINE_FEED);
    if (
      (!allowedWhitespace && code <= CHARACTER_CODE_C0_CONTROL_END) ||
      (code >= CHARACTER_CODE_C1_CONTROL_START && code <= CHARACTER_CODE_C1_CONTROL_END)
    ) {
      return true;
    }
  }
  return false;
}

function mergeRedactions(
  ...results: readonly ScrubberResult[]
): readonly {readonly count: number; readonly name: string}[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const redaction of result.redactions) {
      counts.set(redaction.name, (counts.get(redaction.name) ?? 0) + redaction.count);
    }
  }
  return EffectArray.map(
    [...counts.entries()].sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right))),
    ([name, count]) => ({count, name}),
  );
}

function isThreadnoteIssueUrl(value: string): boolean {
  if (!Effect2.pipe(value, EffectString.startsWith(THREADNOTE_GITHUB_ISSUE_URL_PREFIX))) {
    return false;
  }
  const issueNumber = Effect2.pipe(value, EffectString.slice(THREADNOTE_GITHUB_ISSUE_URL_PREFIX.length));
  return /^[1-9]\d*$/.test(issueNumber);
}
