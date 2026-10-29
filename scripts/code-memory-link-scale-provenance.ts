import {Array as EffectArray} from 'effect';
import {Context, Effect, FileSystem, Layer, Path, Predicate} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect, type CommandExecutor} from '@threadnote/platform/command';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  CODE_MEMORY_LINK_SCALE_ATTEST_STEP,
  CODE_MEMORY_LINK_SCALE_CAPTURE_STEP,
  CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
  CODE_MEMORY_LINK_SCALE_GITHUB_JOB_NAME,
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
  CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH,
  CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
  codeMemoryLinkScaleAttestationSubjectV1,
  evaluateCodeMemoryLinkScaleCapture,
  isCodeMemoryLinkScaleGitHubRepository,
  type CodeMemoryLinkScaleCandidateBindingV1,
  type CodeMemoryLinkScaleIdentityV1,
  type CodeMemoryLinkScaleRunnerBindingV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import {ScriptError} from './effect/errors.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Only this service can supply release authority to executable entrypoints.
 * Tests may replace the service; production always verifies GitHub/Sigstore signatures
 * using the installed gh CLI and independently fetches run/job metadata over HTTPS.
 */
export class CodeMemoryLinkScaleProvenanceVerifier extends Context.Service<
  CodeMemoryLinkScaleProvenanceVerifier,
  {
    readonly verify: (
      subject: string,
      identity: CodeMemoryLinkScaleIdentityV1,
    ) => Effect.Effect<CodeMemoryLinkScaleRunnerBindingV1, unknown>;
  }
>()('threadnote/scripts/code-memory-link-scale-provenance/CodeMemoryLinkScaleProvenanceVerifier') {}

export const CodeMemoryLinkScaleProvenanceLive = Layer.effect(
  CodeMemoryLinkScaleProvenanceVerifier,
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | CommandExecutor>();
    return CodeMemoryLinkScaleProvenanceVerifier.of({
      verify: (subject, identity) => verifyGithubCapture(subject, identity).pipe(Effect.provide(services)),
    });
  }),
);

/** Recompute claims first; unsigned or altered captures cannot be promoted by the production service. */
export const verifyCodeMemoryLinkScaleProvenance = Effect.fn('codeMemoryLinkScale.verifyProvenance')(function* (
  value: unknown,
  candidateBinding: CodeMemoryLinkScaleCandidateBindingV1,
) {
  const unverified = yield* Effect.try({
    try: () => {
      const input = object(value, 'capture artifact');
      return evaluateCodeMemoryLinkScaleCapture({
        budget: CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
        candidateBinding,
        capture: input.capture,
        createdAt: string(input.createdAt, 'createdAt'),
        identity: input.identity,
      });
    },
    catch: cause => ScriptError.make({message: 'Invalid scale capture claims.', cause}),
  });
  if (unverified.identity.invocationMode !== 'release-scale') {
    return yield* ScriptError.make({message: 'Development smoke cannot be promoted to release-scale evidence.'});
  }
  const verifier = yield* CodeMemoryLinkScaleProvenanceVerifier;
  const runnerBinding = yield* verifier.verify(
    codeMemoryLinkScaleAttestationSubjectV1(unverified),
    unverified.identity,
  );
  const artifact = yield* Effect.try({
    try: () =>
      evaluateCodeMemoryLinkScaleCapture({
        budget: CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
        candidateBinding,
        runnerBinding,
        capture: unverified.capture,
        createdAt: unverified.createdAt,
        identity: unverified.identity,
      }),
    catch: cause => ScriptError.make({message: 'Invalid verified scale capture.', cause}),
  });
  if (artifact.evidenceClass !== 'release-scale' || !artifact.gate.passed) {
    return yield* ScriptError.make({
      message: `Verified capture failed release-scale gate: ${EffectArray.join(artifact.gate.failures, '; ')}`,
    });
  }
  return {artifact, runnerBinding};
});

const verifyGithubCapture = Effect.fn('codeMemoryLinkScale.verifyGithubCapture')(function* (
  subject: string,
  identity: CodeMemoryLinkScaleIdentityV1,
) {
  const repository = identity.github.repository;
  if (!isCodeMemoryLinkScaleGitHubRepository(repository)) {
    return yield* ScriptError.make({message: 'Scale capture does not identify an official Threadnote repository.'});
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scale-provenance-'});
      const subjectPath = path.join(root, 'capture.subject.json');
      yield* fs.writeFileString(subjectPath, subject);
      const verified = yield* runCommandEffect(
        'gh',
        [
          'attestation',
          'verify',
          subjectPath,
          '--hostname',
          'github.com',
          '--repo',
          repository,
          '--signer-workflow',
          `${repository}/${CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH}`,
          '--signer-digest',
          identity.candidateCommit,
          '--source-digest',
          identity.candidateCommit,
          '--source-ref',
          identity.github.ref,
          '--deny-self-hosted-runners',
          '--cert-oidc-issuer',
          'https://token.actions.githubusercontent.com',
          '--predicate-type',
          'https://slsa.dev/provenance/v1',
          '--format',
          'json',
        ],
        {maxOutputBytes: 2 * 1024 * 1024, timeoutMs: 120_000},
      );
      const binding = yield* Effect.try({
        try: () =>
          bindingFromVerifiedAttestation(JSON.parse(verified.stdout) as unknown, sha256HexSync(subject), identity),
        catch: cause =>
          ScriptError.make({message: 'Verified GitHub attestation does not bind this scale capture.', cause}),
      });
      const prefix = `repos/${repository}/actions/runs/${binding.github.runId}/attempts/${binding.github.runAttempt}`;
      const [run, jobs] = yield* Effect.all([githubJson(prefix), githubJson(`${prefix}/jobs?per_page=100`)], {
        concurrency: 2,
      });
      yield* Effect.try({
        try: () => assertGithubRunAndJob(run, jobs, binding),
        catch: cause =>
          ScriptError.make({message: 'GitHub run/job metadata does not establish the governed scale runner.', cause}),
      });
      return binding;
    }),
  );
});

function githubJson(endpoint: string) {
  return runCommandEffect('gh', ['api', '--hostname', 'github.com', endpoint], {
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: 30_000,
  }).pipe(
    Effect.flatMap(result =>
      Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: cause => ScriptError.make({message: 'GitHub returned invalid provenance metadata.', cause}),
      }),
    ),
  );
}

/** Only called on successful gh verification output; never accept this JSON from a CLI argument or artifact. */
function bindingFromVerifiedAttestation(
  value: unknown,
  subjectHash: string,
  identity: CodeMemoryLinkScaleIdentityV1,
): CodeMemoryLinkScaleRunnerBindingV1 {
  if (!EffectArray.isArray(value) || value.length === 0) throw new Error('Missing verified attestations');
  const repository = identity.github.repository;
  if (!isCodeMemoryLinkScaleGitHubRepository(repository)) throw new Error('Unexpected Threadnote repository');
  const repositoryUrl = `https://github.com/${repository}`;
  const workflowUrl = `${repositoryUrl}/${CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH}`;
  const expectedInvocation = `${repositoryUrl}/actions/runs/${identity.github.runId}/attempts/${identity.github.runAttempt}`;
  for (const entry of value) {
    const result = object(object(entry, 'attestation').verificationResult, 'verification result');
    const certificate = object(object(result.signature, 'signature').certificate, 'certificate');
    const statement = object(result.statement, 'statement');
    const expected = {
      issuer: 'https://token.actions.githubusercontent.com',
      sourceRepositoryURI: repositoryUrl,
      sourceRepositoryIdentifier: CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID,
      sourceRepositoryDigest: identity.candidateCommit,
      sourceRepositoryRef: identity.github.ref,
      buildSignerURI: `${workflowUrl}@${identity.github.ref}`,
      buildSignerDigest: identity.candidateCommit,
      buildConfigURI: `${workflowUrl}@${identity.github.ref}`,
      buildConfigDigest: identity.candidateCommit,
      buildTrigger: identity.github.eventName,
      runInvocationURI: expectedInvocation,
      runnerEnvironment: 'github-hosted',
    };
    if (
      EffectArray.some(EffectRecord.toEntries(expected), ([key, expectedValue]) => certificate[key] !== expectedValue)
    )
      continue;
    if (
      !EffectArray.isArray(statement.subject) ||
      !EffectArray.some(
        statement.subject,
        subject => object(object(subject, 'subject').digest, 'subject digest').sha256 === subjectHash,
      )
    )
      continue;
    return {
      github: {
        actions: true,
        eventName: string(certificate.buildTrigger, 'build trigger'),
        job: CODE_MEMORY_LINK_SCALE_GITHUB_JOB,
        ref: string(certificate.sourceRepositoryRef, 'source ref'),
        repository,
        repositoryId: string(certificate.sourceRepositoryIdentifier, 'repository ID'),
        runId: identity.github.runId,
        runAttempt: identity.github.runAttempt,
        sha: string(certificate.sourceRepositoryDigest, 'source digest'),
        workflowRef: Effect2.pipe(
          string(certificate.buildConfigURI, 'workflow URI'),
          EffectString.slice('https://github.com/'.length),
        ),
        workflowSha: string(certificate.buildConfigDigest, 'workflow digest'),
      },
      runnerClass: CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
      runnerArchitecture: 'ARM64',
      runnerEnvironment: 'github-hosted',
      runnerOperatingSystem: 'macOS',
    };
  }
  throw new Error(
    'No certificate matches exact repository, workflow, candidate, run, attempt, event and hosted runner',
  );
}

function assertGithubRunAndJob(
  runValue: unknown,
  jobsValue: unknown,
  binding: CodeMemoryLinkScaleRunnerBindingV1,
): void {
  const run = object(runValue, 'GitHub run');
  const repository = object(run.repository, 'GitHub repository');
  const github = binding.github;
  if (
    run.id !== github.runId ||
    run.run_attempt !== github.runAttempt ||
    run.head_sha !== github.sha ||
    run.event !== github.eventName ||
    run.path !== CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH ||
    repository.id !== Number(CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID) ||
    repository.full_name !== github.repository
  ) {
    throw new Error('Run metadata mismatch');
  }
  const jobs = object(jobsValue, 'GitHub jobs');
  if (!EffectArray.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length)
    throw new Error('Incomplete bounded job metadata');
  const matches = EffectArray.filter(
    EffectArray.map(jobs.jobs, value => object(value, 'job')),
    job => job.name === CODE_MEMORY_LINK_SCALE_GITHUB_JOB_NAME,
  );
  if (matches.length !== 1) throw new Error('Missing unique governed scale job');
  const job = matches[0];
  if (
    job.run_id !== github.runId ||
    job.run_attempt !== github.runAttempt ||
    job.head_sha !== github.sha ||
    !EffectArray.isArray(job.labels) ||
    !job.labels.includes('macos-15') ||
    job.labels.includes('self-hosted') ||
    !((job.status === 'completed' && job.conclusion === 'success') || job.status === 'in_progress')
  ) {
    throw new Error('Runner job identity or status mismatch');
  }
  if (!EffectArray.isArray(job.steps)) throw new Error('Missing capture/signing steps');
  for (const name of [CODE_MEMORY_LINK_SCALE_CAPTURE_STEP, CODE_MEMORY_LINK_SCALE_ATTEST_STEP]) {
    const steps = EffectArray.filter(
      EffectArray.map(job.steps, value => object(value, 'step')),
      step => step.name === name,
    );
    if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') {
      throw new Error(`Missing successful ${name}`);
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}
