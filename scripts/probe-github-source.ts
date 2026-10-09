import {Effect, Layer, Redacted} from 'effect';
import {admittedSourceFetch} from '@threadnote/integration-core/source-coordinator';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {getRuntimeConfig} from '@threadnote/threadnote/runtime';
import {runtimeEntrypointLayer} from '@threadnote/threadnote/effect/runtime-entrypoint';
import {telemetryChildEnvironmentPolicyLayer} from '@threadnote/threadnote/telemetry/session';
import {
  createGitHubClient,
  GitHubClientError,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  githubSnapshotHash,
  type GitHubClientOptions,
} from '@threadnote/integration-github/client';

export async function probeGitHubSource(
  token: Redacted.Redacted<string>,
  repositoryName: string,
  options: GitHubClientOptions & {readonly number?: number} = {},
) {
  if (options.number !== undefined && (!Number.isSafeInteger(options.number) || options.number < 1))
    throw new GitHubClientError({code: 'contract-invalid'});
  const client = createGitHubClient(token, options);
  try {
    const repository = await client.repository(repositoryName);
    const inventory = await client.listIssues(repository.name, 1);
    const selected = options.number === undefined ? undefined : await client.candidate(repository.name, options.number);
    const conversation = selected === undefined ? undefined : await client.stableConversation(repository, selected);
    return {
      endpoint: GITHUB_API_ORIGIN,
      apiVersion: GITHUB_API_VERSION,
      repository: {stableIdentity: true, private: repository.private},
      inventory: {
        sampledItems: inventory.items.length,
        hasMore: inventory.hasMore,
        scope: 'first-page-sample' as const,
        issues: inventory.items.filter(item => item.kind === 'issue').length,
        pullRequests: inventory.items.filter(item => item.kind === 'pull').length,
      },
      ...(conversation === undefined
        ? {}
        : {
            conversation: {
              kind: conversation.kind,
              observedStable: true,
              snapshotHash: githubSnapshotHash(conversation),
              comments: conversation.comments.length,
              reviews: conversation.reviews.length,
              reviewThreads: conversation.threads.length,
              reviewComments: conversation.threads.reduce((count, thread) => count + thread.comments.length, 0),
            },
          }),
      requests: client.requests,
      externalMutations: false,
    };
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  try {
    const token = process.env.THREADNOTE_GITHUB_TOKEN;
    const repository = process.env.GITHUB_PROBE_REPOSITORY;
    const numberText = process.env.GITHUB_PROBE_NUMBER;
    if (!token || !repository || (numberText !== undefined && !/^[1-9][0-9]*$/.test(numberText)))
      throw new GitHubClientError({code: 'contract-invalid'});
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* getRuntimeConfig();
        const credential = Redacted.make(token);
        const fetch = yield* admittedSourceFetch('github', credential, undefined, config);
        return yield* Effect.tryPromise(() =>
          probeGitHubSource(credential, repository, {
            fetch,
            ...(numberText === undefined ? {} : {number: Number(numberText)}),
          }),
        );
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This script is the application entry point.
        Effect.provide(
          ApplicationLayer.pipe(
            Layer.provide(Layer.merge(runtimeEntrypointLayer, telemetryChildEnvironmentPolicyLayer)),
          ),
        ),
      ),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof GitHubClientError ? error.code : 'transport-rejected';
    process.stderr.write(`GitHub source probe: ${code}\n`);
    process.exitCode = 1;
  }
}
