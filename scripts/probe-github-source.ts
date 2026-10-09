import {Redacted} from 'effect';
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
    const result = await probeGitHubSource(Redacted.make(token), repository, {
      ...(numberText === undefined ? {} : {number: Number(numberText)}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof GitHubClientError ? error.code : 'transport-rejected';
    process.stderr.write(`GitHub source probe: ${code}\n`);
    process.exitCode = 1;
  }
}
