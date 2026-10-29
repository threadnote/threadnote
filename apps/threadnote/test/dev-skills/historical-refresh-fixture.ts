import {Array, Record, type Path} from 'effect';
import type {DevSkillsBundle, DevSkillsConsumer} from '../../src/dev_skills/contract.js';
import {installedSummary} from '../../src/dev_skills/capabilities.js';
import {hash, stableJson} from '../../src/dev_skills/files.js';
import {parseHistoricalDevSkillsManifest} from '../../src/dev_skills/manifest.js';
import {consumerId} from '../../src/dev_skills/registry.js';
import type {RefreshRequest, RefreshState} from '../../src/dev_skills/refresh_state.js';

/** Schema1 uses the released Python-era wire shape; payload bytes remain fixture-owned. */
export function historicalBundle(bundle: DevSkillsBundle): DevSkillsBundle {
  const {digest: _digest, nativeRequirements: _native, prerequisites: _prerequisites, ...base} = bundle.manifest;
  const manifest = {
    ...base,
    schemaVersion: 1 as const,
    prerequisites: {python: '>=3.10', commands: ['threadnote', 'git', 'rg'], prCommands: ['gh']},
  };
  // Canonical ordering is the release builder's contract, not arbitrary object insertion order.
  const canonical = {
    schemaVersion: manifest.schemaVersion,
    workflowProtocol: manifest.workflowProtocol,
    stateSchema: manifest.stateSchema,
    minimumRuntime: manifest.minimumRuntime,
    releaseVersion: manifest.releaseVersion,
    prerequisites: manifest.prerequisites,
    skills: manifest.skills,
    hashes: manifest.hashes,
  };
  return {
    manifest: parseHistoricalDevSkillsManifest({...canonical, digest: hash(JSON.stringify(canonical))}),
    files: bundle.files,
  };
}

export function retainedRefreshState(
  path: Path.Path,
  bundle: DevSkillsBundle,
  consumers: readonly DevSkillsConsumer[],
  outcome: 'current' | 'pending' | 'skipped' = 'current',
): RefreshState {
  const root = consumers[0].installationRoot;
  const manifest = bundle.manifest;
  const request: RefreshRequest = {
    schemaVersion: 1,
    release: {
      installationRoot: root,
      releaseRoot: path.join(root, 'versions', manifest.releaseVersion),
      releaseVersion: manifest.releaseVersion,
      bundleDigest: manifest.digest,
    },
    capabilities:
      manifest.schemaVersion === 1
        ? {
            schemaVersion: 1,
            runtimeVersion: manifest.releaseVersion,
            workflowProtocols: [1],
            stateSchemas: [1],
            enrollmentSchemas: [1, 2],
          }
        : {
            schemaVersion: 2,
            runtimeVersion: manifest.releaseVersion,
            workflowProtocols: [1],
            stateSchemas: [1],
            enrollmentSchemas: [1, 2],
            manifestSchemas: [1, 2],
            nativeFeatures: manifest.nativeRequirements!,
          },
    desired: manifest,
    runtimeHash: hash('original runtime index'),
    members: Array.map(consumers, consumer => ({
      consumerId: consumerId(consumer),
      enrollment: {...consumer, state: outcome === 'skipped' ? 'removed' : 'enrolled', enabled: outcome !== 'skipped'},
      retained: outcome === 'skipped' ? [] : [installedSummary(manifest)],
      ...(outcome === 'skipped' ? {} : {installed: installedSummary(manifest)}),
      receiptHash: hash('original physical receipt'),
      homeHash: hash('original home index'),
      observedHash: hash('original discovery'),
      issues: [],
    })),
    affected: [],
  };
  const intentId = hash(stableJson(request));
  return {
    schemaVersion: 1,
    intentId,
    request,
    outcomes: Record.fromEntries(
      Array.map(request.members, member => [
        member.consumerId,
        {
          intentId,
          requestedReleaseVersion: manifest.releaseVersion,
          requestedBundleDigest: manifest.digest,
          state: outcome,
          attemptedAt: '2026-10-28T00:00:00.000Z',
          ...(outcome === 'pending' ? {} : {completedAt: '2026-10-28T00:00:01.000Z'}),
          issues: [],
        },
      ]),
    ),
  };
}
