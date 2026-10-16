#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Isolated native CLI evaluation adapter. */

import {appendFile, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  topicStudyHash,
  classifyTopicStudyProposalV1,
  gradeTopicStudyAnswerV1,
  measureTopicStudyPreservationV1,
  topicStudyBodyV1,
  topicStudyWrittenReceiptV1,
  topicStudySourceConflictV1,
  topicStudyProbePromptV1,
  topicStudyUnavailableObservationV1,
  type TopicStudyArm,
  type TopicStudyEventV1,
  type TopicStudyObservationV1,
  type TopicStudyProbeObservationV1,
} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';
import {
  readBoundedChildOutput,
  topicStudyEnvironment,
  topicStudyCommitEnvironment,
} from './topic-maintenance-longitudinal-process.js';
import {
  applyTopicStudySourceChanges,
  assertTopicStudyModel,
  topicStudySourceTreeHash,
  type TopicStudyVerifiedModel,
  type TopicStudyRuntimeFingerprint,
} from './topic-maintenance-longitudinal-runtime.js';

export interface TopicStudyNativeRequest {
  readonly version: 1;
  readonly event: TopicStudyEventV1;
  readonly arm: TopicStudyArm;
  readonly manifestPath: string;
  readonly binary: string;
  readonly repository: string;
  readonly home: string;
  readonly baseline: string;
}

interface RunManifest {
  readonly modelId: string;
  readonly alternateModelId: string | null;
  readonly alternatePermitted: boolean;
  readonly verifiedModel: TopicStudyVerifiedModel;
  readonly runtime: TopicStudyRuntimeFingerprint;
}

interface State {
  readonly uri: string;
  readonly memoryId: string;
  readonly caseId: string;
  readonly accepted: string;
  readonly originalParagraphs: readonly string[];
  readonly lastEvidenceRevision: string | null;
  readonly reviewId: string | null;
  readonly reviewRevision: number | null;
  readonly naiveBody: string;
  readonly manualUri: string | null;
  readonly manualBody: string;
  readonly lastApplied: {readonly reviewId: string; readonly revision: number; readonly digest: string} | null;
}

const MAX_COMMAND_BYTES = 512 * 1024;
const MAX_SECONDS = 300;

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly elapsed: number;
};
type LocalGeneration = {
  readonly draft: string | null;
  readonly elapsedMilliseconds: number;
  readonly model: TopicStudyObservationV1['model'];
  readonly promptHash: string;
  readonly providerInputTokens: number | null;
  readonly providerOutputTokens: number | null;
  readonly providerChargeMicros: number | null;
};

/** Injectable process ports keep the public CLI execution contract testable without loading a model. */
export async function runTopicStudyNativeAdapter(
  request: TopicStudyNativeRequest,
  ports: {
    readonly execute?: (command: readonly string[], input?: string) => Promise<CommandResult>;
    readonly generate?: (prompt: string) => Promise<LocalGeneration | null>;
  } = {},
): Promise<TopicStudyObservationV1> {
  if (request.version !== 1 || !request.repository.startsWith(request.home.replace(/\/home$/u, '')))
    throw new Error('Invalid sandbox adapter request.');
  const manifest = JSON.parse(await readFile(request.manifestPath, 'utf8')) as RunManifest;
  const statePath = join(request.home, 'study-state.json');
  let state: State | null = request.event.index === 1 ? null : (JSON.parse(await readFile(statePath, 'utf8')) as State);
  const receipts: string[] = [];
  const observationUnavailable = new Error('Maintenance current-event observation unavailable within bounded turns.');
  const tracePath = join(request.home, 'command-trace.jsonl');
  const env = topicStudyCommitEnvironment(
    topicStudyEnvironment({
      ...process.env,
      THREADNOTE_USER: 'local',
      THREADNOTE_TELEMETRY: 'off',
      NO_COLOR: '1',
    }),
    request.event.index,
    true,
  );
  const run = async (command: readonly string[], input?: string) => {
    if (ports.execute) {
      const result = await ports.execute(command, input);
      const trace = {eventIndex: request.event.index, command, input: input ?? null, ...result};
      receipts.push(topicStudyHash('topic-study-command-receipt-v1', trace));
      await appendFile(tracePath, JSON.stringify(trace) + '\n');
      return result;
    }
    const child = Bun.spawn([...command], {
      cwd: request.repository,
      env,
      stdin: input === undefined ? 'ignore' : new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), MAX_SECONDS * 1000);
    const started = performance.now();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readBoundedChildOutput(child.stdout, MAX_COMMAND_BYTES, () => child.kill()),
        readBoundedChildOutput(child.stderr, MAX_COMMAND_BYTES, () => child.kill()),
        child.exited,
      ]);
      const elapsed = Math.round(performance.now() - started);
      const trace = {eventIndex: request.event.index, command, input: input ?? null, stdout, stderr, exitCode, elapsed};
      receipts.push(topicStudyHash('topic-study-command-receipt-v1', trace));
      await appendFile(tracePath, JSON.stringify(trace) + '\n');
      return {stdout, stderr, exitCode, elapsed};
    } finally {
      clearTimeout(timer);
    }
  };
  const cli = async (args: readonly string[], required = true) => {
    const result = await run([request.binary, ...args]);
    if (required && result.exitCode !== 0)
      throw new Error(`CLI ${args.slice(0, 3).join(' ')} exited ${result.exitCode}.`);
    return result;
  };
  const localModel = async (prompt: string) => {
    if (ports.generate) return ports.generate(prompt);
    await assertTopicStudyModel(manifest.verifiedModel);
    const helper = join(import.meta.dir, 'topic-maintenance-longitudinal-local-model.ts');
    const result = await run(
      [process.execPath, helper],
      JSON.stringify({
        home: join(request.home, 'data-home'),
        modelId: manifest.modelId,
        prompt,
        verifiedModel: manifest.verifiedModel,
        runtime: manifest.runtime,
      }),
    );
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout) as {
      draft: string | null;
      elapsedMilliseconds: number;
      model: TopicStudyObservationV1['model'];
      promptHash: string;
      providerInputTokens: number | null;
      providerOutputTokens: number | null;
      providerChargeMicros: number | null;
    };
    await assertTopicStudyModel(manifest.verifiedModel);
    return parsed;
  };
  const git = async (args: readonly string[]) => {
    const result = await run(['git', ...args]);
    if (result.exitCode !== 0) throw new Error(`Sandbox Git ${args[0]} exited ${result.exitCode}.`);
    return result.stdout.trim();
  };
  const commit = async (label: string) => {
    await git(['add', '-A']);
    await git([
      '-c',
      'user.name=Topic Study',
      '-c',
      'user.email=topic-study@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      label,
    ]);
  };
  let postReviewCompleted = false;
  const finishSourceTimeline = async () => {
    if (postReviewCompleted) return;
    const changed = await applyTopicStudySourceChanges(request.repository, request.event.postReviewChanges);
    if (changed) {
      await commit(`${request.event.id}-post-review`);
      await cli(['graph', 'index', '--cwd', request.repository, '--no-vectors']);
    }
    postReviewCompleted = true;
  };
  const readAccepted = async (uri: string) => {
    const read = await cli(['read', uri]);
    const index = read.stdout.indexOf('MEMORY\n');
    if (index < 0) throw new Error('CLI read had no canonical MEMORY section.');
    return read.stdout.slice(index).trim();
  };
  const maintain = async (memoryId: string) => {
    const requestedAt = Date.now();
    const started = performance.now();
    for (let turn = 0; turn < 8 && performance.now() - started < 30_000; turn++) {
      const response = await cli(['context', 'maintain', '--project', 'fixture', '--action', 'run', '--json']);
      const result = JSON.parse(response.stdout) as {
        state?: string;
        paused?: boolean;
        cases?: readonly Record<string, unknown>[];
      };
      const selected = result.cases?.find(item => item.family === 'topic-maintenance' && item.memoryId === memoryId);
      if (
        result.paused !== true &&
        ['idle', 'needs-decision', 'waiting-evidence'].includes(result.state ?? '') &&
        selected &&
        Date.parse(String(selected.lastChecked)) >= requestedAt &&
        ['needs-decision', 'waiting-evidence', 'resolved'].includes(String(selected.disposition))
      )
        return selected;
    }
    throw observationUnavailable;
  };
  const started = performance.now();
  let setupMilliseconds: number | null = null;
  let observation: TopicStudyObservationV1;
  try {
    if (request.event.index === 1) {
      await cli(['graph', 'index', '--cwd', request.repository, '--no-vectors']);
      const fixture = JSON.parse(await readFile(request.baseline, 'utf8')) as {
        paragraphs: readonly {text: string; role: string; support: string; sourcePath: string; scope?: string}[];
        additionalDependencies: readonly {kind: string; sourcePath: string}[];
      };
      const body = fixture.paragraphs.map(paragraph => paragraph.text).join('\n\n');
      const stored = await cli([
        'remember',
        '--project',
        'fixture',
        '--topic',
        'context-health',
        '--text',
        body,
        '--code-ref',
        'health.ts',
        '--code-ref',
        'config.ts',
        '--require-current-code-refs',
      ]);
      const uri = /Stored memory:\s+(threadnote:\/\/\S+)/u.exec(stored.stdout)?.[1];
      if (!uri) throw new Error('Enrollment setup did not return a target URI.');
      const inspect = JSON.parse((await cli(['context', 'topic', 'inspect', '--uri', uri, '--json'])).stdout) as {
        memoryId: string;
        citations: readonly {path: string; id: string}[];
      };
      const citationIds = Object.fromEntries(inspect.citations.map(item => [item.path, item.id]));
      const input = {
        paragraphs: fixture.paragraphs.map(paragraph => ({
          role: paragraph.role,
          support: paragraph.support,
          ...(paragraph.scope ? {scope: paragraph.scope} : {}),
          citationIds: [citationIds[paragraph.sourcePath]],
        })),
        additionalDependencies: fixture.additionalDependencies.map(item => ({
          kind: item.kind,
          citationId: citationIds[item.sourcePath],
        })),
      };
      const supportPath = join(request.home, 'enrollment.json');
      await writeFile(supportPath, JSON.stringify(input));
      const args = ['--uri', uri, '--cwd', request.repository, '--input', supportPath, '--json'];
      const preview = JSON.parse((await cli(['context', 'topic', 'preview', ...args])).stdout) as {
        proposal: {expectedContentHash: string; revision: string};
      };
      await cli([
        'context',
        'topic',
        'enroll',
        ...args,
        '--content-hash',
        preview.proposal.expectedContentHash,
        '--revision',
        preview.proposal.revision,
        '--approved',
      ]);
      const accepted = await readAccepted(uri);
      let manualUri: string | null = null;
      if (request.arm === 'scripted-manual') {
        const manual = await cli([
          'remember',
          '--project',
          'fixture',
          '--topic',
          'manual-comparator',
          '--text',
          body,
          '--code-ref',
          'health.ts',
          '--code-ref',
          'config.ts',
          '--require-current-code-refs',
        ]);
        manualUri = /Stored memory:\s+(threadnote:\/\/\S+)/u.exec(manual.stdout)?.[1] ?? null;
        if (!manualUri) throw new Error('Manual comparator setup did not return a memory URI.');
      }
      const firstCase = await maintain(inspect.memoryId);
      if (!firstCase || typeof firstCase.caseId !== 'string') throw new Error('Enrolled topic case absent.');
      state = {
        uri,
        memoryId: inspect.memoryId,
        caseId: firstCase.caseId,
        accepted,
        originalParagraphs: fixture.paragraphs.map(item => item.text),
        lastEvidenceRevision: String(firstCase.evidenceRevision ?? ''),
        reviewId: null,
        reviewRevision: null,
        naiveBody: body,
        manualUri,
        manualBody: body,
        lastApplied: null,
      };
    } else {
      if (!state) throw new Error('Missing sequential state.');
      if (request.event.indexGraph) await cli(['graph', 'index', '--cwd', request.repository, '--no-vectors']);
    }
    if (!state) throw new Error('Setup did not produce enrolled state.');
    if (request.event.index === 1) setupMilliseconds = Math.round(performance.now() - started);
    let sourceCommit = await git(['rev-parse', 'HEAD']);
    let sourceTreeHash = await topicStudySourceTreeHash(request.repository);
    const before = await readAccepted(state.uri);
    const evaluatedBefore =
      request.arm === 'naive-local'
        ? state.naiveBody
        : request.arm === 'scripted-manual' && state.manualUri
          ? await readAccepted(state.manualUri)
          : before;
    const scanStarted = performance.now();
    const caseRecord = await maintain(state.memoryId);
    const scanMilliseconds = Math.round(performance.now() - scanStarted);
    let evidenceMilliseconds = 0;
    const disposition = String(caseRecord?.disposition ?? 'missing');
    const evidenceRevision = String(caseRecord?.evidenceRevision ?? '');
    const detected = disposition === 'needs-decision' && evidenceRevision !== state.lastEvidenceRevision;
    let actualClass: TopicStudyObservationV1['actualClass'] =
      disposition === 'waiting-evidence' ? 'unavailable' : detected ? 'review-required' : 'unchanged';
    let draftAttempted = false;
    let draftCompleted = false;
    let accepted = false;
    let approved = false;
    let model: TopicStudyObservationV1['model'] = null;
    let promptHash: string | null = null;
    let providerInputTokens: number | null = null;
    let providerOutputTokens: number | null = null;
    let providerChargeMicros: number | null = 0;
    let computeMilliseconds: number | null = null;
    let status: TopicStudyObservationV1['status'] = 'observed';
    let reason: string | null = null;
    let faultExecuted = false;
    const supportedReviewFault = ['source-race', 'reject', 'defer-resume'].includes(request.event.fault);
    if (detected && request.arm.startsWith('maintained') && (request.event.fault === 'none' || supportedReviewFault)) {
      const backend = request.arm === 'maintained-local' ? 'local-ai' : 'effect-ai';
      const modelId = request.arm === 'maintained-local' ? manifest.modelId : manifest.alternateModelId;
      if (!modelId || (backend === 'effect-ai' && !manifest.alternatePermitted)) {
        status = 'unavailable';
        reason = 'Selected generation backend is not configured/permitted.';
      } else {
        const packet = await cli(
          ['context', 'maintain', '--action', 'packet', '--case-id', state.caseId, '--json'],
          false,
        );
        evidenceMilliseconds += packet.elapsed;
        if (packet.exitCode !== 0) {
          status = 'failed';
          reason = 'Evidence packet failed.';
        } else {
          draftAttempted = true;
          const draft = await cli(
            [
              'context',
              'maintain',
              '--action',
              'draft',
              '--case-id',
              state.caseId,
              '--backend',
              backend,
              '--model-id',
              modelId,
              '--json',
            ],
            false,
          );
          computeMilliseconds = draft.elapsed;
          if (draft.exitCode !== 0) {
            status = 'failed';
            reason = 'Draft generation failed.';
          } else {
            const result = JSON.parse(draft.stdout) as {
              reviewId: string;
              revision: number;
              maintenance?: {
                proposal?: unknown;
                generation?: {
                  usage?: {inputTokens?: number; outputTokens?: number; costMicros?: number};
                  model?: string;
                  modelVersion?: string;
                  promptVersion?: string;
                  attempts?: number;
                };
              };
            };
            draftCompleted = true;
            const generation = result.maintenance?.generation;
            model = {
              backend,
              id: generation?.model ?? modelId,
              digest:
                backend === 'local-ai' &&
                generation?.model === manifest.verifiedModel.id &&
                generation.modelVersion?.includes(manifest.verifiedModel.sha256)
                  ? manifest.verifiedModel.sha256
                  : null,
              modelVersion: generation?.modelVersion ?? null,
              settingsHash: generation?.modelVersion
                ? topicStudyHash('topic-study-receipt-settings-v1', generation.modelVersion)
                : null,
              promptVersion: generation?.promptVersion ?? null,
              attempts: generation?.attempts ?? null,
            };
            // V1 public generation receipts expose versions/settings/attempts, but no actual prompt hashes.
            promptHash = null;
            providerInputTokens = generation?.usage?.inputTokens ?? null;
            providerOutputTokens = generation?.usage?.outputTokens ?? null;
            providerChargeMicros = backend === 'local-ai' ? 0 : null;
            state = {...state, reviewId: result.reviewId, reviewRevision: result.revision};
            const proposalClass = classifyTopicStudyProposalV1(result.maintenance?.proposal);
            if (
              generation?.model !== modelId ||
              !generation.modelVersion ||
              !generation.promptVersion ||
              ![1, 2].includes(generation.attempts ?? 0) ||
              (backend === 'local-ai' && model.digest === null)
            ) {
              status = 'failed';
              reason = 'Actual generation receipt does not match the verified selected model/version.';
            } else if (proposalClass === 'policy-conflict' || proposalClass === 'insufficient-evidence') {
              actualClass = proposalClass;
              if ((await readAccepted(state.uri)) !== before) {
                status = 'failed';
                reason = 'Non-applicable proposal changed accepted content.';
              }
            } else if (proposalClass !== 'applicable') {
              status = 'failed';
              reason = 'Private review did not return a recognized validated proposal outcome.';
            } else {
              const preview = await cli(
                [
                  'context',
                  'maintain',
                  '--action',
                  'draft-preview',
                  '--review-id',
                  result.reviewId,
                  '--revision',
                  String(result.revision),
                  '--source-cwd',
                  request.repository,
                  '--json',
                ],
                false,
              );
              if (preview.exitCode !== 0) {
                status = 'failed';
                reason = 'Draft review preview failed.';
              } else {
                const prepared = JSON.parse(preview.stdout) as {
                  revision: number;
                  maintenanceApproval?: {preview?: {content: string; approvalDigest: string}};
                };
                const document = prepared.maintenanceApproval?.preview?.content ?? '';
                const preservation = measureTopicStudyPreservationV1(
                  before,
                  document,
                  request.event.allowedEditOrdinals,
                );
                const protectedText =
                  preservation.identityPreserved === true &&
                  preservation.provenancePreserved === true &&
                  preservation.unrelatedBodyPreserved === true;
                let currentSeconds: string | null = null;
                try {
                  currentSeconds =
                    /(?:^|\n)export const timeoutSeconds = (\d+);/u.exec(
                      await readFile(join(request.repository, 'config.ts'), 'utf8'),
                    )?.[1] ?? null;
                } catch {
                  /* Missing source cannot authorize a current assertion. */
                }
                const matchesCurrent =
                  currentSeconds !== null &&
                  /production fixture timeout is (\d+) seconds/iu.exec(topicStudyBodyV1(document))?.[1] ===
                    currentSeconds;
                if (protectedText && matchesCurrent && prepared.maintenanceApproval?.preview?.approvalDigest) {
                  const approvalDigest = prepared.maintenanceApproval.preview.approvalDigest;
                  const denied = await cli(
                    [
                      'context',
                      'maintain',
                      '--action',
                      'draft-apply',
                      '--review-id',
                      result.reviewId,
                      '--revision',
                      String(prepared.revision),
                      '--source-cwd',
                      request.repository,
                      '--approval-digest',
                      approvalDigest,
                      '--json',
                    ],
                    false,
                  );
                  if (denied.exitCode === 0 || (await readAccepted(state.uri)) !== before) {
                    status = 'failed';
                    reason = 'Apply without explicit approval was not refused.';
                  } else if (request.event.fault === 'reject') {
                    const decision = await cli(
                      [
                        'context',
                        'maintain',
                        '--action',
                        'draft-reject',
                        '--review-id',
                        result.reviewId,
                        '--revision',
                        String(prepared.revision),
                        '--case-id',
                        state.caseId,
                        '--json',
                      ],
                      false,
                    );
                    if (decision.exitCode !== 0) {
                      status = 'failed';
                      reason = 'Public reject decision failed.';
                    } else faultExecuted = true;
                  } else if (request.event.fault === 'defer-resume') {
                    const deferred = await cli(
                      [
                        'context',
                        'maintain',
                        '--action',
                        'draft-defer',
                        '--review-id',
                        result.reviewId,
                        '--revision',
                        String(prepared.revision),
                        '--case-id',
                        state.caseId,
                        '--json',
                      ],
                      false,
                    );
                    if (deferred.exitCode !== 0) {
                      status = 'failed';
                      reason = 'Public defer decision failed.';
                    } else {
                      const deferredReview = JSON.parse(deferred.stdout) as {revision: number};
                      const resumed = await cli(
                        [
                          'context',
                          'maintain',
                          '--action',
                          'draft-resume',
                          '--review-id',
                          result.reviewId,
                          '--revision',
                          String(deferredReview.revision),
                          '--case-id',
                          state.caseId,
                          '--json',
                        ],
                        false,
                      );
                      if (resumed.exitCode !== 0) {
                        status = 'failed';
                        reason = 'Public resume decision failed.';
                      } else {
                        const resumedReview = JSON.parse(resumed.stdout) as {revision: number};
                        const preparedAgain = await cli(
                          [
                            'context',
                            'maintain',
                            '--action',
                            'draft-preview',
                            '--review-id',
                            result.reviewId,
                            '--revision',
                            String(resumedReview.revision),
                            '--source-cwd',
                            request.repository,
                            '--json',
                          ],
                          false,
                        );
                        if (preparedAgain.exitCode !== 0) {
                          status = 'failed';
                          reason = 'Resumed review preview failed.';
                        } else {
                          const resumedPreview = JSON.parse(preparedAgain.stdout) as {
                            revision: number;
                            maintenanceApproval?: {preview?: {content: string; approvalDigest: string}};
                          };
                          const resumedContent = resumedPreview.maintenanceApproval?.preview?.content ?? '';
                          const resumedDigest = resumedPreview.maintenanceApproval?.preview?.approvalDigest;
                          if (
                            !resumedDigest ||
                            measureTopicStudyPreservationV1(before, resumedContent, request.event.allowedEditOrdinals)
                              .unrelatedBodyPreserved !== true ||
                            /production fixture timeout is (\d+) seconds/iu.exec(
                              topicStudyBodyV1(resumedContent),
                            )?.[1] !== currentSeconds
                          ) {
                            status = 'failed';
                            reason = 'Resumed draft failed independent content check.';
                          } else {
                            const applied = await cli(
                              [
                                'context',
                                'maintain',
                                '--action',
                                'draft-apply',
                                '--review-id',
                                result.reviewId,
                                '--revision',
                                String(resumedPreview.revision),
                                '--source-cwd',
                                request.repository,
                                '--approval-digest',
                                resumedDigest,
                                '--approved',
                                '--json',
                              ],
                              false,
                            );
                            if (
                              applied.exitCode === 0 &&
                              topicStudyWrittenReceiptV1(JSON.parse(applied.stdout), {
                                reviewId: result.reviewId,
                                revision: resumedPreview.revision,
                                digest: resumedDigest,
                                content: resumedContent,
                              }) &&
                              (await readAccepted(state.uri)) === resumedContent
                            ) {
                              accepted = true;
                              approved = true;
                              actualClass = 'review-required';
                              faultExecuted = true;
                              state = {
                                ...state,
                                lastApplied: {
                                  reviewId: result.reviewId,
                                  revision: resumedPreview.revision,
                                  digest: resumedDigest,
                                },
                              };
                            } else {
                              status = 'failed';
                              reason = 'Resumed reviewed apply failed.';
                            }
                          }
                        }
                      }
                    }
                  } else {
                    if (request.event.fault === 'source-race') {
                      await finishSourceTimeline();
                      sourceCommit = await git(['rev-parse', 'HEAD']);
                      sourceTreeHash = await topicStudySourceTreeHash(request.repository);
                    }
                    const apply = await cli(
                      [
                        'context',
                        'maintain',
                        '--action',
                        'draft-apply',
                        '--review-id',
                        result.reviewId,
                        '--revision',
                        String(prepared.revision),
                        '--source-cwd',
                        request.repository,
                        '--approval-digest',
                        approvalDigest,
                        '--approved',
                        '--json',
                      ],
                      false,
                    );
                    if (request.event.fault === 'source-race') {
                      const unchanged = (await readAccepted(state.uri)) === before;
                      if (unchanged && apply.exitCode !== 0 && topicStudySourceConflictV1(apply.stdout, apply.stderr)) {
                        actualClass = 'stale-conflict';
                        faultExecuted = true;
                      } else {
                        status = unchanged && apply.exitCode !== 0 ? 'unavailable' : 'failed';
                        reason =
                          unchanged && apply.exitCode !== 0
                            ? 'Source refusal lacks a supported exact structured domain error; not counted as successful fault evidence.'
                            : 'Source-race apply was not safely refused.';
                      }
                    } else if (
                      apply.exitCode === 0 &&
                      topicStudyWrittenReceiptV1(JSON.parse(apply.stdout), {
                        reviewId: result.reviewId,
                        revision: prepared.revision,
                        digest: approvalDigest,
                        content: document,
                      }) &&
                      (await readAccepted(state.uri)) === document
                    ) {
                      accepted = true;
                      approved = true;
                      state = {
                        ...state,
                        lastApplied: {reviewId: result.reviewId, revision: prepared.revision, digest: approvalDigest},
                      };
                    } else {
                      status = 'failed';
                      reason = 'Reviewed draft apply failed.';
                    }
                  }
                } else {
                  status = 'failed';
                  reason = 'Independent protected-content/current-value check rejected draft.';
                }
              }
            }
          }
        }
      }
    } else if (request.event.fault === 'duplicate-restart' && request.arm.startsWith('maintained')) {
      if (!state.lastApplied) {
        status = 'unavailable';
        reason = 'No prior reviewed apply receipt to replay.';
      } else {
        const replay = await cli(
          [
            'context',
            'maintain',
            '--action',
            'draft-apply',
            '--review-id',
            state.lastApplied.reviewId,
            '--revision',
            String(state.lastApplied.revision),
            '--source-cwd',
            request.repository,
            '--approval-digest',
            state.lastApplied.digest,
            '--approved',
            '--json',
          ],
          false,
        );
        if ((await readAccepted(state.uri)) !== before) {
          status = 'failed';
          reason = 'Duplicate apply changed accepted bytes.';
        } else if (
          replay.exitCode === 0 &&
          topicStudyWrittenReceiptV1(JSON.parse(replay.stdout), {...state.lastApplied, content: before})
        ) {
          actualClass = 'review-required';
          faultExecuted = true;
        } else {
          status = 'failed';
          reason = 'Duplicate apply returned an unclassified result.';
        }
      }
    } else if (detected && request.arm === 'scripted-manual') {
      let currentValue: string | null = null;
      let stagingValue: string | null = null;
      try {
        const source = await readFile(join(request.repository, 'config.ts'), 'utf8');
        currentValue = /(?:^|\n)export const timeoutSeconds = (\d+);/u.exec(source)?.[1] ?? null;
        stagingValue = /(?:^|\n)export const stagingTimeoutSeconds = (\d+);/u.exec(source)?.[1] ?? null;
      } catch {
        /* Preserve accepted content on missing evidence. */
      }
      if (currentValue !== null) {
        let next = state.manualBody.replace(
          /production fixture timeout is \d+ seconds/iu,
          `production fixture timeout is ${currentValue} seconds`,
        );
        if (request.event.operation === 'heading')
          next = next.replace('The display heading is Context Health.', 'The display heading is Context Health v2.');
        if (request.event.operation === 'staging' && stagingValue !== null) {
          const sentence = `The staging fixture timeout is ${stagingValue} seconds.`;
          const existing = /The staging fixture timeout is \d+ seconds\./giu;
          next = existing.test(next) ? next.replace(existing, sentence) : `${next}\n\n${sentence}`;
        }
        if (next !== state.manualBody && state.manualUri) {
          const updated = await cli(
            [
              'remember',
              '--project',
              'fixture',
              '--topic',
              'manual-comparator',
              '--replace-uri',
              state.manualUri,
              '--text',
              next,
              '--code-ref',
              'health.ts',
              '--code-ref',
              'config.ts',
            ],
            false,
          );
          if (updated.exitCode === 0) {
            const nextUri = /Stored memory:\s+(threadnote:\/\/\S+)/u.exec(updated.stdout)?.[1] ?? null;
            if (nextUri) {
              state = {...state, manualUri: nextUri, manualBody: next};
              accepted = true;
              approved = true;
            } else {
              status = 'failed';
              reason = 'Manual comparator update had no target URI.';
            }
          } else {
            status = 'failed';
            reason = 'Manual comparator update failed.';
          }
        }
      }
    } else if (detected && request.arm === 'naive-local') {
      draftAttempted = true;
      const packet = await cli(
        ['context', 'maintain', '--action', 'packet', '--case-id', state.caseId, '--json'],
        false,
      );
      evidenceMilliseconds += packet.elapsed;
      if (packet.exitCode !== 0) {
        status = 'failed';
        reason = 'Naive evidence packet failed.';
      } else {
        const prompt =
          `Rewrite the entire topic explanation from this evidence. Return only the replacement body.\n\n` +
          `Accepted body:\n${state.naiveBody}\n\nCurrent evidence packet:\n${packet.stdout.slice(0, 16_000)}`;
        const generated = await localModel(prompt);
        model = generated?.model ?? null;
        promptHash = generated?.promptHash ?? null;
        computeMilliseconds = generated?.elapsedMilliseconds ?? null;
        providerInputTokens = generated?.providerInputTokens ?? null;
        providerOutputTokens = generated?.providerOutputTokens ?? null;
        providerChargeMicros = generated?.providerChargeMicros ?? null;
        if (generated === null) {
          status = 'failed';
          reason = 'Naive local model generation failed.';
        } else {
          draftCompleted = true;
          state = {...state, naiveBody: generated.draft ?? state.naiveBody};
        }
      }
    }
    if (
      request.event.fault !== 'none' &&
      request.event.fault !== 'dirty-source' &&
      !faultExecuted &&
      status === 'observed'
    ) {
      status = 'unavailable';
      reason = `Fault ${request.event.fault} requires a dedicated execution adapter.`;
      actualClass = null;
    }
    await finishSourceTimeline();
    sourceCommit = await git(['rev-parse', 'HEAD']);
    sourceTreeHash = await topicStudySourceTreeHash(request.repository);
    const after = await readAccepted(state.uri);
    const evaluatedBody =
      request.arm === 'naive-local'
        ? state.naiveBody
        : request.arm === 'scripted-manual' && state.manualUri
          ? await readAccepted(state.manualUri)
          : after;
    const preservation = measureTopicStudyPreservationV1(
      evaluatedBefore,
      evaluatedBody,
      request.event.allowedEditOrdinals,
    );
    const {identityPreserved, provenancePreserved} = preservation;
    const beforeSections = topicStudyBodyV1(evaluatedBefore).split('\n\n');
    const afterSections = topicStudyBodyV1(evaluatedBody).split('\n\n');
    const unrelatedBodyPreserved =
      preservation.unrelatedBodyPreserved ??
      (beforeSections.length === afterSections.length &&
        beforeSections.every(
          (text, ordinal) => request.event.allowedEditOrdinals.includes(ordinal) || afterSections[ordinal] === text,
        ));
    const probeStart = performance.now();
    const probes: TopicStudyProbeObservationV1[] = [];
    let downstreamModel: TopicStudyObservationV1['model'] = null;
    let downstreamPromptHash: string | null = null;
    let retrievalHash: string | null = null;
    const retrieval = await cli(
      [
        'context',
        'brief',
        '--cwd',
        request.repository,
        '--project',
        'fixture',
        '--budget-tokens',
        '1500',
        '--detail',
        'source',
        '--code-ref',
        'config.ts',
        '--code-ref',
        'health.ts',
        '--task',
        'Retrieve accepted context-health topic, current production and staging timeout evidence, historical timeout, review policy, exception preservation and declared dependency coverage.',
      ],
      false,
    );
    if (retrieval.exitCode !== 0 || !retrieval.stdout.trim()) {
      probes.push(
        ...request.event.probes.map(probe => ({
          id: probe.id,
          answer: null,
          evidence: null,
          judged: 'unavailable' as const,
        })),
      );
    } else {
      retrievalHash = sha256HexSync(retrieval.stdout);
      const probePrompt = topicStudyProbePromptV1(evaluatedBody, retrieval.stdout, request.event.probes);
      const probeGeneration = await localModel(probePrompt);
      const probeResponse = probeGeneration?.draft ?? null;
      downstreamModel = probeGeneration?.model ?? null;
      downstreamPromptHash = probeGeneration?.promptHash ?? null;
      let answers: Record<string, unknown> = {};
      if (probeResponse !== null) {
        try {
          const parsed = JSON.parse(probeResponse) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            answers = parsed as Record<string, unknown>;
        } catch {
          /* Explicit unavailable answers below preserve the denominator. */
        }
      }
      for (const probe of request.event.probes) {
        const answer = typeof answers[probe.id] === 'string' ? (answers[probe.id] as string) : null;
        const judged = gradeTopicStudyAnswerV1(probe, answer);
        probes.push({
          id: probe.id,
          answer: answer && answer.length <= 4096 ? answer : null,
          evidence: answer ? sha256HexSync(probePrompt) : null,
          judged,
        });
      }
    }
    observation = {
      status,
      reason,
      actualClass,
      sourceCommit,
      sourceTreeHash,
      targetBeforeHash: sha256HexSync(evaluatedBefore),
      targetAfterHash: sha256HexSync(evaluatedBody),
      detected,
      draftAttempted,
      draftCompleted,
      accepted,
      approved,
      identityPreserved,
      provenancePreserved,
      unrelatedBodyPreserved,
      model,
      downstreamModel,
      downstreamPromptHash,
      retrievalHash,
      promptHash,
      providerInputTokens,
      providerOutputTokens,
      providerChargeMicros,
      computeMilliseconds,
      reviewerMilliseconds: null,
      evidenceOpens: null,
      correctionBytes: null,
      setupMilliseconds,
      scanMilliseconds,
      evidenceMilliseconds,
      downstreamMilliseconds: Math.round(performance.now() - probeStart),
      retainedBytes: null,
      commandReceiptHashes: receipts,
      probes,
      adjudication: null,
    };
    state = {...state, accepted: after, lastEvidenceRevision: evidenceRevision};
    await writeFile(statePath, JSON.stringify(state));
  } catch (error) {
    await finishSourceTimeline();
    observation = {
      ...topicStudyUnavailableObservationV1(
        request.event,
        error instanceof Error ? error.message : 'Native CLI adapter failed.',
      ),
      status: error === observationUnavailable ? 'unavailable' : 'failed',
      commandReceiptHashes: receipts,
    };
    if (state) await writeFile(statePath, JSON.stringify(state));
  }
  return observation;
}

if (import.meta.main)
  process.stdout.write(
    JSON.stringify(await runTopicStudyNativeAdapter(JSON.parse(await Bun.stdin.text()) as TopicStudyNativeRequest)),
  );
