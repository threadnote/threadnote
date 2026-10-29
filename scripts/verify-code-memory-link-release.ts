#!/usr/bin/env bun
import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, Layer, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1,
  assertCodeMemoryLinkAgentAbRuntimeIdentity,
  evaluateCodeMemoryLinkAgentAb,
  parseCodeMemoryLinkAgentAbManifestV1,
  type CodeMemoryLinkAgentAbManifestV1,
  parseCodeMemoryLinkAgentAbTrialsJsonl,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {parseCodeMemoryLinkAgentAttemptsJsonl} from '@threadnote/threadnote/evaluation/code-memory-link-agent-attempts';
import {parseCodeMemoryLinkAgentEvidenceJsonl} from '@threadnote/threadnote/evaluation/code-memory-link-agent-evidence';
import type {CodeMemoryLinkCodexRawEvidenceV1} from '@threadnote/threadnote/evaluation/code-memory-link-codex-evidence';
import type {CodeMemoryLinkCodexAppServerEvidenceV1} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  assertCodeMemoryLinkSealedSuiteBindingsV1,
  codeMemoryLinkContextBriefResponseReceiptHashV1,
  parseCodeMemoryLinkRubricV1,
  parseCodeMemoryLinkSealedSuiteV1,
  parseCodeMemoryLinkTaskPacketV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientProjectionHash,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {evaluateCodeMemoryLinkDogfood} from '@threadnote/threadnote/evaluation/code-memory-link-dogfood';
import {createCodeMemoryLinkRetainedResultV1} from '@threadnote/threadnote/evaluation/code-memory-link-retained-result';
import {
  CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT,
  parseCodeMemoryLinkRetainedBundleIndexV1,
  type CodeMemoryLinkRetainedBundleContentsV1,
  verifyCodeMemoryLinkRetainedBundleV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-retained-bundle';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  CODE_MEMORY_LINK_SCALE_ARTIFACT_ROOT,
  codeMemoryLinkScaleCandidateBindingV1,
  codeMemoryLinkScaleArtifactPath,
  parseCodeMemoryLinkScaleArtifactV1,
  type CodeMemoryLinkScaleCandidateBindingV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import {rebuildCodeMemoryLinkScaleTargetDigest} from './benchmark-code-memory-link-scale.js';
import {
  CodeMemoryLinkScaleProvenanceLive,
  verifyCodeMemoryLinkScaleProvenance,
} from './code-memory-link-scale-provenance.js';
import {
  CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_ROOT,
  parseCodeMemoryLinkReleaseDescriptorV1,
} from './code-memory-link-release-descriptor.js';
import {
  developmentBuildVersion,
  type DevelopmentRuntimeEvidence,
  verifyManagedDevelopmentRuntimeForSourceCheckout,
} from './development-runtime.js';
import {
  parseCodeMemoryLinkCodexJudgeCommandV1,
  parseCodeMemoryLinkCodexSuiteLayoutV1,
} from './code-memory-link-codex-suite.js';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const path = yield* Path.Path;
  const sourceRoot = yield* path.fromFileUrl(new URL('../', import.meta.url));
  const {governance, release} = yield* resolveGovernedCodeMemoryLinkRelease(
    sourceRoot,
    options.releaseDescriptorPath,
    options.releaseTag,
  );
  if (options.printCandidateCommit) {
    yield* Console.log(release.descriptor.candidate.commit);
    return;
  }
  const runtime = yield* verifyManagedDevelopmentRuntimeForSourceCheckout(
    sourceRoot,
    release.descriptor.candidate.commit,
  );
  const [retained, rebuiltScaleTargetSha256] = yield* Effect.all(
    [
      loadCodeMemoryLinkRetainedBundleAtHead(sourceRoot, governance.commit, release.descriptor.retainedBundle.path),
      Effect.scoped(rebuildCodeMemoryLinkScaleTargetDigest()),
    ],
    {concurrency: 2},
  );
  const scaleCandidateBinding = yield* loadCodeMemoryLinkScaleCandidateBindingAtCommit(
    sourceRoot,
    release.descriptor.candidate.commit,
  );
  const scale = yield* loadCodeMemoryLinkScaleArtifactAtHead(
    sourceRoot,
    governance.commit,
    release.descriptor.scaleArtifact.path,
    release.descriptor.scaleArtifact.sha256,
    release.descriptor.candidate.commit,
    rebuiltScaleTargetSha256,
    scaleCandidateBinding,
  );
  if (
    retained.contents.index.candidateCommit !== release.descriptor.candidate.commit ||
    retained.bundleHash !== release.descriptor.retainedBundle.sha256
  ) {
    return yield* ScriptError.make({message: 'Retained bundle differs from the final release descriptor.'});
  }
  const assignment = json(retained.contents.artifacts.assignment, 'retained assignment');
  const dogfoodArtifact = json(retained.contents.artifacts.dogfood, 'retained dogfood artifact');
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(
    json(retained.contents.artifacts.manifest, 'retained manifest'),
  );
  const attempts = parseCodeMemoryLinkAgentAttemptsJsonl(retained.contents.artifacts.attempts);
  const evidence = parseCodeMemoryLinkAgentEvidenceJsonl(retained.contents.artifacts.evidence);
  const trials = parseCodeMemoryLinkAgentAbTrialsJsonl(retained.contents.artifacts.trials);
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment, manifest, trials});
  const agentAb = evaluateCodeMemoryLinkAgentAb({
    assignment,
    attempts,
    evidence,
    manifest,
    trials,
  });
  const dogfood = evaluateCodeMemoryLinkDogfood(dogfoodArtifact);
  assertRetainedBundleBindings({agentAb, dogfood, evidence, manifest, retained: retained.contents});
  if (agentAb.evidence.manifestApprovalCommit !== null) {
    yield* verifyManifestApproval(
      sourceRoot,
      release.descriptor.candidate.commit,
      governance.commit,
      agentAb.evidence.manifestApprovalCommit,
      agentAb.manifestHash,
    );
    yield* verifyFinalEvidenceApproval(
      sourceRoot,
      agentAb.evidence.manifestApprovalCommit,
      governance.commit,
      agentAb.evidence.externalEvidenceHash,
      dogfood.artifactHash,
      agentAb.manifestHash,
      retained.bundleHash,
      retained.repositoryPaths,
      release.repositoryPath,
      scale.repositoryPath,
    );
  }
  yield* Effect.try({
    try: () => {
      assertCodeMemoryLinkAgentAbRuntimeIdentity(agentAb.candidate, runtime);
      assertCodeMemoryLinkAgentAbRuntimeIdentity(dogfood.candidate, runtime);
      assertCodeMemoryLinkReleaseDescriptorRuntime(release.descriptor.candidate, runtime);
      if (JSON.stringify(agentAb.candidate) !== JSON.stringify(dogfood.candidate)) {
        throw new Error('Agent A/B and dogfood candidate identities differ.');
      }
      if (
        agentAb.evidence.manifestApprovalCommit === null ||
        dogfood.harnessCommit !== agentAb.evidence.manifestApprovalCommit ||
        EffectArray.some(trials, trial => trial.attestation.harnessCommit !== agentAb.evidence.manifestApprovalCommit)
      ) {
        throw new Error('Agent A/B and dogfood did not execute from the same reviewed manifest-approval checkout.');
      }
    },
    catch: cause =>
      ScriptError.make({message: 'Code Memory Link evidence does not match the verified installed runtime.', cause}),
  });
  const finalRuntime = yield* verifyManagedDevelopmentRuntimeForSourceCheckout(
    sourceRoot,
    release.descriptor.candidate.commit,
  );
  if (JSON.stringify(finalRuntime) !== JSON.stringify(runtime)) {
    return yield* ScriptError.make({
      message: 'Managed candidate runtime changed while release evidence was being verified.',
    });
  }
  yield* Effect.try({
    try: () => assertCodeMemoryLinkReleaseDescriptorRuntime(release.descriptor.candidate, finalRuntime),
    catch: cause =>
      ScriptError.make({message: 'Final managed candidate runtime differs from the release descriptor.', cause}),
  });
  const qualityFailures = [...agentAb.gate.qualityFailures, ...dogfood.gate.qualityFailures].sort();
  const insufficiencies = [...agentAb.gate.insufficiencies, ...dogfood.gate.insufficiencies].sort();
  const failures = [...new Set([...qualityFailures, ...insufficiencies])].sort();
  const status = qualityFailures.length > 0 ? 'failed' : failures.length > 0 ? 'insufficient' : 'passed';
  const result = {
    agentAb,
    candidate: agentAb.candidate,
    dogfood,
    gate: {failures, insufficiencies, qualityFailures, status},
    governance,
    releaseDescriptor: {
      path: release.repositoryPath,
      releaseTag: release.descriptor.releaseTag,
    },
    retainedBundle: {
      blobCount: retained.contents.index.blobs.length,
      bundleHash: retained.bundleHash,
      claim: retained.contents.index.claim,
      path: retained.repositoryPath,
    },
    scaleArtifact: {
      builtArtifactSha256: scale.artifact.identity.builtArtifactSha256,
      path: scale.repositoryPath,
      sha256: scale.artifactHash,
    },
    runtime: {executableSha256: finalRuntime.executableSha256, sourceCommit: finalRuntime.sourceCommit},
    type: 'code-memory-link-release-evidence',
    version: 1,
  } as const;
  yield* Console.log(JSON.stringify(result, undefined, 2));
  if (status !== 'passed') return yield* ScriptError.make({message: EffectArray.join(failures, '\n')});
});

/** Establish ancestry and governance before a candidate commit may be printed or executed. */
export const resolveGovernedCodeMemoryLinkRelease = Effect.fn('codeMemoryLinkRelease.resolveGovernedRelease')(
  function* (sourceRoot: string, releaseDescriptorPath: string, releaseTag: string) {
    const governanceCommit = Effect2.pipe((yield* git(sourceRoot, ['rev-parse', 'HEAD'])).stdout, EffectString.trim);
    const release = yield* loadCodeMemoryLinkReleaseDescriptorAtHead(
      sourceRoot,
      governanceCommit,
      releaseDescriptorPath,
      releaseTag,
    );
    const governance = yield* verifyApprovalCheckout(
      sourceRoot,
      release.descriptor.candidate.commit,
      release.repositoryPath,
      release.descriptor.scaleArtifact.path,
    );
    if (governance.commit !== governanceCommit) {
      return yield* ScriptError.make({message: 'The governance checkout changed during release preflight.'});
    }
    return {governance, release};
  },
);

const APPROVALS_PATH = 'apps/threadnote/src/evaluation/code-memory-link-approvals.json';
const GOVERNANCE_ONLY_PATHS = new Set([APPROVALS_PATH]);

export function assertCodeMemoryLinkReleaseDescriptorRuntime(
  candidate: ReturnType<typeof parseCodeMemoryLinkReleaseDescriptorV1>['candidate'],
  runtime: DevelopmentRuntimeEvidence,
): void {
  const observed = {
    commit: runtime.sourceCommit,
    dependencyInstallation: runtime.dependencyInstallation,
    payloadBytes: runtime.payloadBytes,
    payloadFileCount: runtime.payloadFileCount,
    payloadManifestSha256: runtime.payloadManifestSha256,
    releaseMetadataSha256: runtime.releaseMetadataSha256,
    runtime: runtime.runtime,
    sourceLockfileSha256: runtime.sourceLockfileSha256,
    sourcePackageManifestSha256: runtime.sourcePackageManifestSha256,
    target: runtime.target,
    testedCandidateExecutableSha256: runtime.executableSha256,
    version: runtime.version,
  };
  if (JSON.stringify(observed) !== JSON.stringify(candidate)) {
    throw ScriptError.make({
      message: 'Installed candidate payload differs from the complete final release descriptor binding.',
    });
  }
}

export const loadCodeMemoryLinkReleaseDescriptorAtHead = Effect.fn('codeMemoryLinkRelease.loadReleaseDescriptorAtHead')(
  function* (sourceRoot: string, governanceCommit: string, repositoryPath: string, releaseTag: string) {
    const [source, packageSource] = yield* Effect.all(
      [
        readTrackedGitBlob(sourceRoot, governanceCommit, repositoryPath),
        readTrackedGitBlob(sourceRoot, governanceCommit, 'package.json'),
      ],
      {concurrency: 2},
    );
    const descriptor = yield* Effect.try({
      try: () => parseCodeMemoryLinkReleaseDescriptorV1({expectedReleaseTag: releaseTag, repositoryPath, source}),
      catch: cause => ScriptError.make({message: `Final release descriptor is invalid: ${String(cause)}`, cause}),
    });
    const packageVersion = yield* Effect.try({
      try: () => {
        const value = json(packageSource, 'tracked package manifest');
        if (!Predicate.isObject(value) || !('version' in value) || typeof value.version !== 'string') {
          throw new Error('package.json version is missing');
        }
        return value.version;
      },
      catch: cause => ScriptError.make({message: 'Tracked package manifest is invalid.', cause}),
    });
    if (descriptor.releaseTag !== `v${packageVersion}`) {
      return yield* ScriptError.make({message: 'Final release descriptor tag differs from package.json version.'});
    }
    const expectedCandidateVersion = yield* Effect.try({
      try: () => developmentBuildVersion(packageVersion, descriptor.candidate.commit),
      catch: cause => ScriptError.make({message: 'Final release descriptor candidate version is invalid.', cause}),
    });
    if (descriptor.candidate.version !== expectedCandidateVersion) {
      return yield* ScriptError.make({
        message: 'Final release descriptor candidate version differs from candidate C and package.json.',
      });
    }
    return {descriptor, repositoryPath};
  },
);

export const loadCodeMemoryLinkRetainedBundleAtHead = Effect.fn('codeMemoryLinkRelease.loadRetainedBundleAtHead')(
  function* (sourceRoot: string, governanceCommit: string, repositoryPath: string) {
    const match = new RegExp(`^${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}/([0-9a-f]{64})/bundle\\.json$`, 'u').exec(
      repositoryPath,
    );
    if (match === null) {
      return yield* ScriptError.make({
        message: `Retained bundle must be a repository-relative hash-named bundle under ${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}.`,
      });
    }
    const bundleHash = match[1];
    const indexContent = yield* readTrackedGitBlob(sourceRoot, governanceCommit, repositoryPath);
    if (sha256HexSync(indexContent) !== bundleHash) {
      return yield* ScriptError.make({message: 'Retained bundle directory name differs from bundle.json SHA-256.'});
    }
    const index = yield* Effect.try({
      try: () => parseCodeMemoryLinkRetainedBundleIndexV1(json(indexContent, 'retained bundle index')),
      catch: cause => ScriptError.make({message: 'Retained bundle index is invalid.', cause}),
    });
    const bundleDirectory = Effect2.pipe(repositoryPath, EffectString.slice(0, -'/bundle.json'.length));
    const blobEntries = yield* Effect.forEach(
      index.blobs,
      blob => {
        const blobPath = `${bundleDirectory}/${blob.path}`;
        return readTrackedGitBlob(sourceRoot, governanceCommit, blobPath).pipe(
          Effect.map(content => [blob.sha256, content, blobPath] as const),
        );
      },
      {concurrency: 8},
    );
    const contents = yield* Effect.try({
      try: () =>
        verifyCodeMemoryLinkRetainedBundleV1({
          blobs: new Map(EffectArray.map(blobEntries, ([hash, content]) => [hash, content])),
          indexContent,
        }),
      catch: cause => ScriptError.make({message: 'Retained evidence bundle failed content verification.', cause}),
    });
    return {
      bundleHash,
      contents,
      repositoryPath,
      repositoryPaths: [repositoryPath, ...EffectArray.map(blobEntries, ([, , blobPath]) => blobPath)].sort(),
    };
  },
);

export const loadCodeMemoryLinkScaleArtifactAtHead = Effect.fn('codeMemoryLinkRelease.loadScaleArtifactAtHead')(
  function* (
    sourceRoot: string,
    governanceCommit: string,
    repositoryPath: string,
    expectedArtifactSha256: string,
    expectedCandidateCommit: string,
    expectedBuiltArtifactSha256: string,
    candidateBinding: CodeMemoryLinkScaleCandidateBindingV1,
  ) {
    if (
      !/^[0-9a-f]{64}$/u.test(expectedArtifactSha256) ||
      repositoryPath !== codeMemoryLinkScaleArtifactPath(expectedArtifactSha256)
    ) {
      return yield* ScriptError.make({
        message: `Scale artifact must be a repository-relative content-addressed JSON blob under ${CODE_MEMORY_LINK_SCALE_ARTIFACT_ROOT}.`,
      });
    }
    const source = yield* readTrackedGitBlob(sourceRoot, governanceCommit, repositoryPath);
    const artifactHash = sha256HexSync(source);
    if (artifactHash !== expectedArtifactSha256) {
      return yield* ScriptError.make({message: 'Scale artifact bytes differ from the final release descriptor hash.'});
    }
    const payload = yield* Effect.try({
      try: () => json(source, 'retained inverse-selector scale artifact'),
      catch: cause => ScriptError.make({message: 'Retained scale artifact is invalid JSON.', cause}),
    });
    const {runnerBinding} = yield* verifyCodeMemoryLinkScaleProvenance(payload, candidateBinding);
    const artifact = yield* Effect.try({
      try: () =>
        parseCodeMemoryLinkScaleArtifactV1(
          payload,
          CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
          candidateBinding,
          runnerBinding,
        ),
      catch: cause => ScriptError.make({message: 'Retained inverse-selector scale artifact is invalid.', cause}),
    });
    if (`${JSON.stringify(artifact, undefined, 2)}\n` !== source) {
      return yield* ScriptError.make({
        message: 'Retained inverse-selector scale artifact must use canonical JSON encoding.',
      });
    }
    if (
      artifact.evidenceClass !== 'release-scale' ||
      artifact.identity.invocationMode !== 'release-scale' ||
      !artifact.gate.passed
    ) {
      return yield* ScriptError.make({
        message: 'Retained inverse-selector scale artifact did not pass the frozen release-scale gate.',
      });
    }
    if (
      artifact.identity.candidateCommit !== expectedCandidateCommit ||
      artifact.identity.observedCommit !== expectedCandidateCommit ||
      artifact.identity.dirty
    ) {
      return yield* ScriptError.make({
        message: 'Retained inverse-selector scale artifact is not exact clean candidate C evidence.',
      });
    }
    if (artifact.identity.builtArtifactSha256 !== expectedBuiltArtifactSha256) {
      return yield* ScriptError.make({
        message: 'Retained inverse-selector scale artifact differs from the independently rebuilt target.',
      });
    }
    return {artifact, artifactHash, repositoryPath};
  },
);

/** Derive candidate package identity from the exact Git object before replaying retained release evidence. */
export const loadCodeMemoryLinkScaleCandidateBindingAtCommit = Effect.fn(
  'codeMemoryLinkRelease.loadScaleCandidateBindingAtCommit',
)(function* (sourceRoot: string, candidateCommit: string) {
  const manifest = yield* runCommandEffect('git', ['show', `${candidateCommit}:package.json`], {
    cwd: sourceRoot,
    maxOutputBytes: 128 * 1024,
    timeoutMs: 10_000,
  });
  return yield* Effect.try({
    try: () => codeMemoryLinkScaleCandidateBindingV1(candidateCommit, JSON.parse(manifest.stdout) as unknown),
    catch: cause =>
      ScriptError.make({message: 'Could not derive the release candidate package identity for scale evidence.', cause}),
  });
});

export function assertRetainedBundleBindings(input: {
  readonly agentAb: ReturnType<typeof evaluateCodeMemoryLinkAgentAb>;
  readonly dogfood: ReturnType<typeof evaluateCodeMemoryLinkDogfood>;
  readonly evidence: readonly {
    readonly rawEvidence: {
      readonly appServer: Pick<CodeMemoryLinkCodexAppServerEvidenceV1, 'checkpoints'>;
      readonly bindings: Pick<CodeMemoryLinkCodexRawEvidenceV1['bindings'], 'arm' | 'clientId' | 'taskId'>;
      readonly clientProtocol: CodeMemoryLinkCodexRawEvidenceV1['clientProtocol'];
      readonly judge: Pick<
        CodeMemoryLinkCodexRawEvidenceV1['judge'],
        'commandArtifactId' | 'commandSha256' | 'programArtifactId' | 'programSha256'
      >;
    };
  }[];
  readonly manifest: Pick<
    CodeMemoryLinkAgentAbManifestV1,
    'adjudicationArtifactHash' | 'clients' | 'suiteHash' | 'tasks'
  >;
  readonly retained: Pick<CodeMemoryLinkRetainedBundleContentsV1, 'artifacts' | 'clients' | 'sealedFiles'>;
}): void {
  const retainedResult = json(input.retained.artifacts.result, 'retained scored result');
  if (
    JSON.stringify(retainedResult) !==
    JSON.stringify(createCodeMemoryLinkRetainedResultV1({agentAb: input.agentAb, dogfood: input.dogfood}))
  ) {
    throw ScriptError.make({message: 'Retained scored result differs from evaluation of the retained ledgers.'});
  }
  const suite = parseCodeMemoryLinkSealedSuiteV1(json(input.retained.artifacts.sealedSuite, 'retained sealed suite'));
  const layout = parseCodeMemoryLinkCodexSuiteLayoutV1(
    json(input.retained.artifacts.sealedLayout, 'retained sealed layout'),
  );
  const retainedSealedPaths = EffectArray.map(input.retained.sealedFiles, file => file.path).sort();
  const layoutSources = [
    ...EffectArray.map(layout.fixtureFiles, file => file.source),
    ...EffectArray.map(layout.judge.files, file => file.source),
    ...EffectArray.flatMap(layout.tasks, task => [task.packetSource, task.rubricSource]),
  ];
  if (new Set(layoutSources).size !== layoutSources.length) {
    throw ScriptError.make({message: 'Retained sealed layout source paths must be unique.'});
  }
  const expectedSealedPaths = EffectArray.filter(layoutSources, source => source !== 'adapter.json').sort();
  if (JSON.stringify(retainedSealedPaths) !== JSON.stringify(expectedSealedPaths)) {
    throw ScriptError.make({message: 'Retained sealed files differ from the complete layout source set.'});
  }
  const sealedRawHashes = new Set([
    sha256HexSync(input.retained.artifacts.sealedLayout),
    ...EffectArray.map(input.retained.sealedFiles, file => sha256HexSync(file.content)),
  ]);
  if (
    suite.suiteHash !== input.manifest.suiteHash ||
    suite.judge.judgeHash !== input.manifest.adjudicationArtifactHash ||
    !EffectArray.some(
      suite.judge.artifacts,
      artifact => artifact.sha256 === sha256HexSync(input.retained.artifacts.sealedLayout),
    ) ||
    EffectArray.some(
      [...suite.fixture.artifacts, ...suite.judge.artifacts],
      artifact => !sealedRawHashes.has(artifact.sha256),
    )
  ) {
    throw ScriptError.make({
      message: 'Retained sealed suite or layout differs from the manifest adjudication bindings.',
    });
  }
  const sealedContentByPath = new Map(EffectArray.map(input.retained.sealedFiles, file => [file.path, file.content]));
  const fixtureArtifactById = new Map(
    EffectArray.map(suite.fixture.artifacts, artifact => [artifact.artifactId, artifact]),
  );
  const judgeArtifactById = new Map(
    EffectArray.map(suite.judge.artifacts, artifact => [artifact.artifactId, artifact]),
  );
  if (
    JSON.stringify(EffectArray.map(layout.fixtureFiles, file => file.artifactId)) !==
      JSON.stringify(EffectArray.map(suite.fixture.artifacts, artifact => artifact.artifactId)) ||
    JSON.stringify(EffectArray.map(layout.judge.files, file => file.artifactId)) !==
      JSON.stringify(EffectArray.map(suite.judge.artifacts, artifact => artifact.artifactId))
  ) {
    throw ScriptError.make({message: 'Retained sealed layout differs from the suite artifact rosters.'});
  }
  for (const file of [...layout.fixtureFiles, ...layout.judge.files]) {
    const descriptor = fixtureArtifactById.get(file.artifactId) ?? judgeArtifactById.get(file.artifactId);
    const content =
      file.source === 'adapter.json' ? input.retained.artifacts.sealedLayout : sealedContentByPath.get(file.source);
    if (!descriptor || content === undefined || sha256HexSync(content) !== descriptor.sha256) {
      throw ScriptError.make({
        message: `Retained sealed artifact ${file.artifactId} differs from its suite descriptor.`,
      });
    }
  }
  const layoutArtifact = EffectOption.getOrUndefined(
    EffectArray.findFirst(layout.judge.files, file => file.artifactId === layout.layoutArtifactId),
  );
  const commandArtifact = EffectOption.getOrUndefined(
    EffectArray.findFirst(layout.judge.files, file => file.artifactId === layout.judge.commandArtifactId),
  );
  if (!layoutArtifact || layoutArtifact.source !== 'adapter.json' || !commandArtifact) {
    throw ScriptError.make({
      message: 'Retained sealed layout omits its exact layout or judge-command artifact binding.',
    });
  }
  const commandContent = sealedContentByPath.get(commandArtifact.source);
  if (commandContent === undefined)
    throw ScriptError.make({message: 'Retained sealed layout omits the judge command bytes.'});
  const judgeCommand = parseCodeMemoryLinkCodexJudgeCommandV1(json(commandContent, 'retained sealed judge command'));
  const sealedFiles = input.retained.sealedFiles;
  const packets = EffectArray.map(
    EffectArray.filter(
      sealedFiles,
      (file, index) => index in sealedFiles && Effect2.pipe(file.path, EffectString.endsWith('/packet.json')),
    ),
    file => parseCodeMemoryLinkTaskPacketV1(json(file.content, `retained ${file.path}`)),
  );
  const rubrics = EffectArray.map(
    EffectArray.filter(
      sealedFiles,
      (file, index) => index in sealedFiles && Effect2.pipe(file.path, EffectString.endsWith('/rubric.json')),
    ),
    file => parseCodeMemoryLinkRubricV1(json(file.content, `retained ${file.path}`)),
  );
  assertCodeMemoryLinkSealedSuiteBindingsV1({rubrics, suite, taskPackets: packets});
  const suiteTaskBindings = EffectArray.map(suite.tasks, ({packetHash, rubricHash, taskId, taskKind}) => ({
    packetHash,
    rubricHash,
    taskId,
    taskKind,
  })).sort((left, right) => Effect2.pipe(left.taskId, EffectString.localeCompare(right.taskId)));
  const manifestTaskBindings = EffectArray.map(input.manifest.tasks, ({packetHash, rubricHash, taskId, taskKind}) => ({
    packetHash,
    rubricHash,
    taskId,
    taskKind,
  })).sort((left, right) => Effect2.pipe(left.taskId, EffectString.localeCompare(right.taskId)));
  if (JSON.stringify(suiteTaskBindings) !== JSON.stringify(manifestTaskBindings)) {
    throw ScriptError.make({message: 'Retained sealed suite task roster differs from the manifest task roster.'});
  }
  for (const task of input.manifest.tasks) {
    const packet = EffectArray.filter(packets, value => value.taskId === task.taskId);
    const rubric = EffectArray.filter(rubrics, value => value.taskId === task.taskId);
    const layoutTask = EffectArray.filter(layout.tasks, value => value.taskId === task.taskId);
    if (
      packet.length !== 1 ||
      rubric.length !== 1 ||
      layoutTask.length !== 1 ||
      packet[0].packetHash !== task.packetHash ||
      rubric[0].rubricHash !== task.rubricHash ||
      layoutTask[0].packetHash !== task.packetHash ||
      layoutTask[0].rubricHash !== task.rubricHash ||
      codeMemoryLinkContextBriefResponseReceiptHashV1(layoutTask[0].preflightExpectedResponses.anchored) !==
        task.expectedResponseHashes.anchored ||
      codeMemoryLinkContextBriefResponseReceiptHashV1(layoutTask[0].preflightExpectedResponses.noMemory) !==
        task.expectedResponseHashes.noMemory ||
      codeMemoryLinkContextBriefResponseReceiptHashV1(layoutTask[0].preflightExpectedResponses.taskOnly) !==
        task.expectedResponseHashes.taskOnly
    ) {
      throw ScriptError.make({
        message: `Retained layout, packet, rubric, or response projection differs from task ${task.taskId}.`,
      });
    }
  }
  const expectedClients = [...input.manifest.clients].sort((left, right) =>
    Effect2.pipe(left.clientId, EffectString.localeCompare(right.clientId)),
  );
  const retainedClients = [...input.retained.clients].sort((left, right) =>
    Effect2.pipe(left.clientId, EffectString.localeCompare(right.clientId)),
  );
  if (
    JSON.stringify(EffectArray.map(retainedClients, client => client.clientId)) !==
    JSON.stringify(EffectArray.map(expectedClients, client => client.clientId))
  ) {
    throw ScriptError.make({message: 'Retained client descriptor/config-projection roster differs from the manifest.'});
  }
  for (const [index, client] of retainedClients.entries()) {
    const expected = expectedClients[index];
    const descriptorInput = json(client.descriptor, `${client.clientId} retained descriptor`);
    const descriptor = parseCodeMemoryLinkClientImplementationDescriptorV1(descriptorInput);
    const descriptorHash = codeMemoryLinkClientImplementationDescriptorHash(descriptorInput);
    const configurationProjectionHash = sha256HexSync(client.configProjection);
    const clientEvidence = EffectArray.filter(
      input.evidence,
      receipt => receipt.rawEvidence.bindings.clientId === client.clientId,
    );
    if (clientEvidence.length === 0) {
      throw ScriptError.make({message: `Retained evidence omits manifest client ${client.clientId}.`});
    }
    const expectedProjectionHashes = new Set(
      EffectArray.map(clientEvidence, receipt => {
        const protocol = receipt.rawEvidence.clientProtocol;
        if (JSON.stringify(protocol.expectedClient) !== JSON.stringify(expected.expectedClient)) {
          throw ScriptError.make({
            message: `Retained app-server identity for ${client.clientId} differs from the manifest expected client.`,
          });
        }
        const expectedProjectionHash = codeMemoryLinkClientProjectionHash('expected-client', {
          ...protocol.expectedClient,
          proxyTool: protocol.proxyTool,
        });
        if (
          protocol.configurationProjectionHash !== expected.configurationProjectionHash ||
          protocol.environmentPolicyHash !== expected.environmentPolicyHash ||
          protocol.executionBundleHash !== expected.executionBundleHash ||
          protocol.expectedClientProjectionHash !== expectedProjectionHash
        ) {
          throw ScriptError.make({
            message: `Retained client protocol for ${client.clientId} differs from the manifest/descriptor identity projection.`,
          });
        }
        return expectedProjectionHash;
      }),
    );
    if (
      descriptorHash !== expected.implementationDescriptorHash ||
      configurationProjectionHash !== expected.configurationProjectionHash ||
      descriptor.configurationProjectionHash !== configurationProjectionHash ||
      descriptor.environmentPolicyHash !== expected.environmentPolicyHash ||
      descriptor.executionBundleHash !== expected.executionBundleHash ||
      expectedProjectionHashes.size !== 1 ||
      !expectedProjectionHashes.has(descriptor.expectedClientProjectionHash)
    ) {
      throw ScriptError.make({
        message: `Retained descriptor/config projection for ${client.clientId} differs from the manifest or app-server identity binding.`,
      });
    }
  }
  for (const receipt of input.evidence) {
    const raw = receipt.rawEvidence;
    const task = EffectOption.getOrUndefined(
      EffectArray.findFirst(input.manifest.tasks, candidate => candidate.taskId === raw.bindings.taskId),
    )!;
    if (
      raw.judge.commandArtifactId !== layout.judge.commandArtifactId ||
      raw.judge.programArtifactId !== judgeCommand.programArtifactId ||
      judgeArtifactById.get(raw.judge.commandArtifactId)?.sha256 !== raw.judge.commandSha256 ||
      judgeArtifactById.get(raw.judge.programArtifactId)?.sha256 !== raw.judge.programSha256
    ) {
      throw ScriptError.make({
        message: `Retained judge execution for ${raw.bindings.taskId} differs from the sealed suite judge artifacts.`,
      });
    }
    const observedResponseHashes = EffectArray.flatMap(raw.appServer.checkpoints, checkpoint => {
      if (
        checkpoint.method !== 'item/completed' ||
        checkpoint.itemType !== 'mcpToolCall' ||
        checkpoint.succeeded !== true ||
        checkpoint.proxyReceipt === null
      ) {
        return [];
      }
      return [checkpoint.proxyReceipt.responseHash];
    });
    const expectedResponseHash =
      raw.bindings.arm === 'anchored'
        ? task.expectedResponseHashes.anchored
        : raw.bindings.arm === 'no-memory'
          ? task.expectedResponseHashes.noMemory
          : task.expectedResponseHashes.taskOnly;
    if (observedResponseHashes.length !== 1 || observedResponseHashes[0] !== expectedResponseHash) {
      throw ScriptError.make({
        message: `Retained Context Brief response for ${raw.bindings.taskId}/${raw.bindings.arm} differs from the manifest preregistration.`,
      });
    }
  }
}

const readTrackedGitBlob = Effect.fn('codeMemoryLinkRelease.readTrackedGitBlob')(function* (
  sourceRoot: string,
  revision: string,
  repositoryPath: string,
) {
  const [listing, content] = yield* Effect.all(
    [
      git(sourceRoot, ['ls-tree', revision, '--', repositoryPath]),
      gitEvidence(sourceRoot, ['show', `${revision}:${repositoryPath}`]),
    ],
    {concurrency: 2},
  );
  const [metadata, trackedPath, ...extra] = Effect2.pipe(
    listing.stdout,
    EffectString.trimEnd,
    EffectString.split('\t'),
  );
  if (
    extra.length > 0 ||
    trackedPath !== repositoryPath ||
    typeof metadata !== 'string' ||
    !/^100644 blob [0-9a-f]{40,64}$/u.test(metadata)
  ) {
    return yield* ScriptError.make({
      message: `Release evidence path must be one exact non-executable regular Git blob: ${repositoryPath}`,
    });
  }
  return content.stdout;
});

export const verifyApprovalCheckout = Effect.fn('codeMemoryLinkRelease.verifyApprovalCheckout')(function* (
  sourceRoot: string,
  candidateCommit: string,
  releaseDescriptorPath?: string,
  scaleArtifactPath?: string,
) {
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    return yield* ScriptError.make({message: 'The tested candidate must be an exact 40-character Git commit.'});
  }
  if (
    releaseDescriptorPath !== undefined &&
    !new RegExp(`^${CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_ROOT}/v[^/]+\\.json$`, 'u').test(releaseDescriptorPath)
  ) {
    return yield* ScriptError.make({message: 'Release descriptor path is outside version-bound governance.'});
  }
  if (
    scaleArtifactPath !== undefined &&
    !new RegExp(`^${CODE_MEMORY_LINK_SCALE_ARTIFACT_ROOT}/[0-9a-f]{64}\\.json$`, 'u').test(scaleArtifactPath)
  ) {
    return yield* ScriptError.make({message: 'Scale artifact path is outside content-addressed governance.'});
  }
  const [commitResult, mergeBaseResult, statusResult, historyResult] = yield* Effect.all(
    [
      git(sourceRoot, ['rev-parse', 'HEAD']),
      git(sourceRoot, ['merge-base', candidateCommit, 'HEAD']),
      git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
      git(sourceRoot, ['rev-list', '--ancestry-path', '--reverse', '--parents', `${candidateCommit}..HEAD`]),
    ],
    {concurrency: 4},
  );
  const commit = Effect2.pipe(commitResult.stdout, EffectString.trim);
  if (Effect2.pipe(statusResult.stdout, EffectString.trim)) {
    return yield* ScriptError.make({message: 'Release evidence verification requires a clean governance checkout.'});
  }
  if (Effect2.pipe(mergeBaseResult.stdout, EffectString.trim) !== candidateCommit) {
    return yield* ScriptError.make({message: 'The tested candidate must be an ancestor of the governance checkout.'});
  }
  const history = parseLinearGovernanceHistory(historyResult.stdout, candidateCommit, commit);
  const changedByCommit = yield* Effect.forEach(
    history,
    entry =>
      git(sourceRoot, ['diff', '--name-only', '--no-renames', entry.parent, entry.commit]).pipe(
        Effect.map(result => ({commit: entry.commit, paths: lines(result.stdout)})),
      ),
    {concurrency: 4},
  );
  const changedPaths = [...new Set(EffectArray.flatMap(changedByCommit, entry => entry.paths))].sort();
  const allowedGovernancePaths = new Set(GOVERNANCE_ONLY_PATHS);
  if (releaseDescriptorPath !== undefined) allowedGovernancePaths.add(releaseDescriptorPath);
  if (scaleArtifactPath !== undefined) allowedGovernancePaths.add(scaleArtifactPath);
  const invalidPaths = EffectArray.filter(
    changedPaths,
    value =>
      !allowedGovernancePaths.has(value) &&
      !Effect2.pipe(value, EffectString.startsWith('apps/threadnote/test/evaluation/retained/code-memory-link/')),
  );
  if (invalidPaths.length > 0) {
    const offendingCommits = EffectArray.join(
      EffectArray.map(
        EffectArray.filter(
          changedByCommit,
          (entry, __effectArrayIndex) =>
            __effectArrayIndex in changedByCommit && EffectArray.some(entry.paths, path => invalidPaths.includes(path)),
        ),
        entry => entry.commit,
      ),
      ', ',
    );
    return yield* ScriptError.make({
      message: `Runtime or product files changed in post-candidate history (${offendingCommits}): ${EffectArray.join(invalidPaths, ', ')}`,
    });
  }
  return {changedPaths, commit, governanceCommits: EffectArray.map(history, entry => entry.commit)};
});

export const verifyManifestApproval = Effect.fn('codeMemoryLinkRelease.verifyManifestApproval')(function* (
  sourceRoot: string,
  candidateCommit: string,
  governanceCommit: string,
  approvalCommit: string,
  manifestHash: string,
) {
  if (approvalCommit === candidateCommit || approvalCommit === governanceCommit) {
    return yield* ScriptError.make({
      message: 'Manifest approval must be a distinct commit before the post-run evidence approval commit.',
    });
  }
  const [candidateBase, governanceBase, approvalParents] = yield* Effect.all(
    [
      git(sourceRoot, ['merge-base', candidateCommit, approvalCommit]),
      git(sourceRoot, ['merge-base', approvalCommit, governanceCommit]),
      git(sourceRoot, ['rev-list', '--parents', '-n', '1', approvalCommit]),
    ],
    {concurrency: 3},
  );
  if (
    Effect2.pipe(candidateBase.stdout, EffectString.trim) !== candidateCommit ||
    Effect2.pipe(governanceBase.stdout, EffectString.trim) !== approvalCommit
  ) {
    return yield* ScriptError.make({
      message: 'Manifest approval chronology does not descend candidate -> approval -> evidence governance.',
    });
  }
  const parents = Effect2.pipe(approvalParents.stdout, EffectString.trim, EffectString.split(/\s+/u));
  if (parents.length !== 2) {
    return yield* ScriptError.make({message: 'Manifest approval must be a single-parent governance commit.'});
  }
  const parentCommit = parents[1];
  if (parentCommit !== candidateCommit) {
    return yield* ScriptError.make({
      message: 'Manifest approval must be the immediate governance commit after the tested candidate.',
    });
  }
  const [approvalDiff, approvalSource, parentSource] = yield* Effect.all(
    [
      git(sourceRoot, ['diff', '--name-status', '--no-renames', parentCommit, approvalCommit]),
      readTrackedGitBlob(sourceRoot, approvalCommit, APPROVALS_PATH),
      readTrackedGitBlob(sourceRoot, parentCommit, APPROVALS_PATH),
    ],
    {concurrency: 3},
  );
  if (JSON.stringify(changeStatusLines(approvalDiff.stdout)) !== JSON.stringify([`M\t${APPROVALS_PATH}`])) {
    return yield* ScriptError.make({
      message: 'The manifest approval commit must change only the reviewed approvals JSON file.',
    });
  }
  const [before, after] = yield* Effect.all(
    [parseApprovalJsonEffect(parentSource), parseApprovalJsonEffect(approvalSource)],
    {concurrency: 2},
  );
  if (
    !sameHashes(after.manifests, [...before.manifests, manifestHash]) ||
    JSON.stringify(after.externalEvidence) !== JSON.stringify(before.externalEvidence) ||
    JSON.stringify(after.dogfoodEvidence) !== JSON.stringify(before.dogfoodEvidence) ||
    JSON.stringify(after.retainedBundles) !== JSON.stringify(before.retainedBundles)
  ) {
    return yield* ScriptError.make({
      message:
        'The trial approval commit must add exactly the preregistered manifest hash to the parsed manifest allowlist.',
    });
  }
});

export const verifyFinalEvidenceApproval = Effect.fn('codeMemoryLinkRelease.verifyFinalEvidenceApproval')(function* (
  sourceRoot: string,
  approvalCommit: string,
  governanceCommit: string,
  externalEvidenceHash: string,
  dogfoodEvidenceHash: string,
  manifestHash: string,
  retainedBundleHash: string,
  retainedBundlePaths: readonly string[],
  releaseDescriptorPath: string,
  scaleArtifactPath: string,
) {
  if (approvalCommit === governanceCommit) {
    return yield* ScriptError.make({
      message: 'Final evidence approval must follow the distinct preregistered manifest approval commit.',
    });
  }
  const [governanceBase, governanceParents, approvalSource, finalDiff, finalSource] = yield* Effect.all(
    [
      git(sourceRoot, ['merge-base', approvalCommit, governanceCommit]),
      git(sourceRoot, ['rev-list', '--parents', '-n', '1', governanceCommit]),
      readTrackedGitBlob(sourceRoot, approvalCommit, APPROVALS_PATH),
      git(sourceRoot, ['diff', '--name-status', '--no-renames', approvalCommit, governanceCommit]),
      readTrackedGitBlob(sourceRoot, governanceCommit, APPROVALS_PATH),
    ],
    {concurrency: 5},
  );
  if (Effect2.pipe(governanceBase.stdout, EffectString.trim) !== approvalCommit) {
    return yield* ScriptError.make({
      message: 'Final evidence approval chronology must descend from the manifest approval commit.',
    });
  }
  const finalParents = Effect2.pipe(governanceParents.stdout, EffectString.trim, EffectString.split(/\s+/u));
  if (finalParents.length !== 2 || finalParents[1] !== approvalCommit) {
    return yield* ScriptError.make({
      message: 'Final evidence approval must be the immediate single-parent commit after manifest approval.',
    });
  }
  const [before, after] = yield* Effect.all(
    [parseApprovalJsonEffect(approvalSource), parseApprovalJsonEffect(finalSource)],
    {concurrency: 2},
  );
  const expectedFinalChanges = [
    `M\t${APPROVALS_PATH}`,
    `A\t${releaseDescriptorPath}`,
    `A\t${scaleArtifactPath}`,
    ...EffectArray.map(retainedBundlePaths, path => `A\t${path}`),
  ].sort();
  if (JSON.stringify(changeStatusLines(finalDiff.stdout).sort()) !== JSON.stringify(expectedFinalChanges)) {
    return yield* ScriptError.make({
      message:
        'Final evidence approval must modify only approvals and add the exact retained bundle, scale artifact, and version-bound release descriptor.',
    });
  }
  if (
    before.externalEvidence.includes(externalEvidenceHash) ||
    before.dogfoodEvidence.includes(dogfoodEvidenceHash) ||
    before.retainedBundles.includes(retainedBundleHash)
  ) {
    return yield* ScriptError.make({
      message: 'The reviewed external-agent and dogfood evidence hashes must not preexist their final approval.',
    });
  }
  if (
    !before.manifests.includes(manifestHash) ||
    !sameHashes(after.manifests, before.manifests) ||
    !sameHashes(after.externalEvidence, [...before.externalEvidence, externalEvidenceHash]) ||
    !sameHashes(after.dogfoodEvidence, [...before.dogfoodEvidence, dogfoodEvidenceHash]) ||
    !sameHashes(after.retainedBundles, [...before.retainedBundles, retainedBundleHash])
  ) {
    return yield* ScriptError.make({
      message:
        'Approval-to-HEAD governance must add exactly the reviewed external-agent, dogfood, and retained-bundle hashes while leaving manifest approvals unchanged.',
    });
  }
});

interface GovernanceHistoryEntry {
  readonly commit: string;
  readonly parent: string;
}

function parseLinearGovernanceHistory(
  source: string,
  candidateCommit: string,
  governanceCommit: string,
): readonly GovernanceHistoryEntry[] {
  const history: GovernanceHistoryEntry[] = [];
  let expectedParent = candidateCommit;
  for (const line of lines(source)) {
    const [commit, ...parents] = Effect2.pipe(line, EffectString.split(/\s+/u));
    if (!commit || parents.length !== 1 || parents[0] !== expectedParent) {
      throw ScriptError.make({
        message: 'Post-candidate evidence governance must be a linear, single-parent commit history.',
      });
    }
    history.push({commit, parent: parents[0]});
    expectedParent = commit;
  }
  if (expectedParent !== governanceCommit) {
    throw ScriptError.make({message: 'Post-candidate evidence governance history does not terminate at HEAD.'});
  }
  return history;
}

interface ParsedApprovalJson {
  readonly dogfoodEvidence: readonly string[];
  readonly externalEvidence: readonly string[];
  readonly manifests: readonly string[];
  readonly retainedBundles: readonly string[];
}

function parseApprovalJson(source: string): ParsedApprovalJson {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    throw ScriptError.make({message: 'Approval data must be valid JSON.', cause});
  }
  if (!Predicate.isObject(value)) {
    throw ScriptError.make({message: 'Approval data must be a JSON object.'});
  }
  const record = value;
  const expectedKeys = [
    'agentAbEvidenceHashes',
    'agentAbManifestHashes',
    'dogfoodEvidenceHashes',
    'retainedEvidenceBundleHashes',
    'version',
  ];
  if (JSON.stringify(EffectRecord.keys(record).sort()) !== JSON.stringify([...expectedKeys].sort())) {
    throw ScriptError.make({message: `Approval data must contain exactly: ${EffectArray.join(expectedKeys, ', ')}.`});
  }
  if (record.version !== 1) throw ScriptError.make({message: 'Approval data version must be 1.'});
  return {
    dogfoodEvidence: parseHashArray(record.dogfoodEvidenceHashes, 'dogfoodEvidenceHashes'),
    externalEvidence: parseHashArray(record.agentAbEvidenceHashes, 'agentAbEvidenceHashes'),
    manifests: parseHashArray(record.agentAbManifestHashes, 'agentAbManifestHashes'),
    retainedBundles: parseHashArray(record.retainedEvidenceBundleHashes, 'retainedEvidenceBundleHashes'),
  };
}

function parseApprovalJsonEffect(source: string) {
  return Effect.try({try: () => parseApprovalJson(source), catch: scriptError});
}

function parseHashArray(value: unknown, name: string): readonly string[] {
  if (
    !EffectArray.isArray(value) ||
    EffectArray.some(value, hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash))
  ) {
    throw ScriptError.make({message: `${name} must contain only lowercase SHA-256 hashes.`});
  }
  const values = EffectArray.filter(value, (hash): hash is string => typeof hash === 'string');
  if (new Set(values).size !== values.length)
    throw ScriptError.make({message: `${name} must not contain duplicate hashes.`});
  return values;
}

function sameHashes(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function lines(source: string): string[] {
  return EffectArray.filter(
    EffectArray.map(Effect2.pipe(source, EffectString.split(/\r?\n/u)), value =>
      Effect2.pipe(value, EffectString.trim),
    ),
    Boolean,
  );
}

function changeStatusLines(source: string): string[] {
  const changes = lines(source);
  if (EffectArray.some(changes, change => !/^[ACDMTUXB]\t[^\t]+$/u.test(change))) {
    throw ScriptError.make({message: 'Final evidence approval contains an unsupported Git change status.'});
  }
  return changes;
}

function git(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', args, {cwd, maxOutputBytes: 1_048_576, timeoutMs: 30_000});
}

function gitEvidence(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', args, {cwd, maxOutputBytes: 34 * 1_048_576, timeoutMs: 30_000});
}

function json(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    throw ScriptError.make({message: `${label} must be valid JSON.`, cause});
  }
}

function parseArguments(args: readonly string[]): {
  readonly printCandidateCommit: boolean;
  readonly releaseDescriptorPath: string;
  readonly releaseTag: string;
} {
  const values: Record<string, string | undefined> = {};
  let printCandidateCommit = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--print-candidate-commit') {
      if (printCandidateCommit)
        throw ScriptError.make({message: '--print-candidate-commit may be specified only once.'});
      printCandidateCommit = true;
      continue;
    }
    if (!['--release-descriptor', '--release-tag'].includes(argument)) {
      throw ScriptError.make({message: `Unknown Code Memory Link release evidence option: ${argument}`});
    }
    if (values[argument] !== undefined) throw ScriptError.make({message: `${argument} may be specified only once.`});
    values[argument] = required(args[++index], argument);
  }
  const releaseDescriptorPath = values['--release-descriptor'];
  const releaseTag = values['--release-tag'];
  if (!releaseDescriptorPath || !releaseTag) {
    throw ScriptError.make({message: 'Release verification requires --release-descriptor and --release-tag.'});
  }
  return {
    printCandidateCommit,
    releaseDescriptorPath,
    releaseTag,
  };
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main)
  BunRuntime.runMain(
    provideScriptLayer(program, CodeMemoryLinkScaleProvenanceLive.pipe(Layer.provideMerge(ApplicationLayer))),
  );
