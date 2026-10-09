import {it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {StandaloneBrokerLayer} from '../../src/effect/runtime-bootstrap.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {describe, expect, it} from 'vitest';
import {buildContextHealthReport} from '@threadnote/context/health';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  canonicalMemoryDocumentContent,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {buildContextMaintenancePacket} from '../../src/memory/context/maintenance_packet.js';
import {prepareMaintenanceSemanticProgress} from '../../src/memory/context/maintenance_decisions.js';
import {previewContextHealthRepairPlanV1} from '../../src/memory/context/health_repair.js';
import {renderContextHealth} from '../../src/memory/context/health_commands.js';

const now = new Date('2026-06-01T00:00:00.000Z');
function memory(name: string, text: string): MemoryRecord {
  return parseMemoryDocument(
    `threadnote://user/tester/memories/durable/projects/threadnote/${name}.md`,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        project: 'threadnote',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: now.toISOString(),
        validFrom: '2026-01-01',
        validTo: '2027-01-01',
        memoryId: name,
      },
      text,
    ),
  )!;
}
const records = [
  memory('a', '# Production\nTimeout is 60 seconds.'),
  memory('b', '# Production\nTimeout must be 30 seconds.'),
];

describe('semantic evidence application boundaries', () => {
  it('invalidates pre-upgrade completed semantic progress and retains current completed progress', () => {
    const hashes = new Map(records.map(record => [record.uri, sha256HexSync(record.content)]));
    const legacyGeneration = sha256HexSync(records.map(record => `${record.uri}:${hashes.get(record.uri)}`).join('|'));
    const old = {
      threadnote: {generation: legacyGeneration, cursor: 1, totalBatches: 1, eligibleRecords: 2, partial: false},
    };
    const upgraded = prepareMaintenanceSemanticProgress(records, hashes, old as never);
    expect(upgraded.pending).toEqual(['threadnote']);
    expect(upgraded.progress.threadnote.cursor).toBe(0);
    expect(upgraded.generations.get('threadnote')).not.toBe(legacyGeneration);
    const completed = {
      threadnote: {
        ...upgraded.progress.threadnote,
        cursor: 1,
        records: upgraded.progress.threadnote.records.map(record => ({
          ...record,
          claims: 1,
          unsupportedClaims: 0,
          reasons: [],
        })),
        comparison: {pairCursor: 1, claimCursor: 0, seenCaseIds: []},
      },
    };
    expect(prepareMaintenanceSemanticProgress(records, hashes, completed).pending).toEqual([]);
    expect(prepareMaintenanceSemanticProgress([...records].reverse(), hashes, completed).pending).toEqual([]);
    const priorAnalyzer = {
      threadnote: {...completed.threadnote, analyzerVersion: 1},
    };
    const rebuilt = prepareMaintenanceSemanticProgress(records, hashes, priorAnalyzer);
    expect(rebuilt.pending).toEqual(['threadnote']);
    expect(rebuilt.progress.threadnote.records.every(record => record.claims === undefined)).toBe(true);
    expect(rebuilt.progress.threadnote.comparison).toMatchObject({pairCursor: 0, claimCursor: 0});
  });
  effectIt.effect('carries both exact source claims and policy reason into a revision-checked review-only packet', () =>
    Effect.gen(function* () {
      const original = structuredClone(records);
      const report = buildContextHealthReport({project: 'threadnote', records, now});
      const finding = report.findings.find(finding => finding.category === 'semantic-contradiction')!;
      let revisionChecks = 0;
      const packet = yield* buildContextMaintenancePacket(
        {
          account: 'local',
          agentContextHome: '/unused',
          agentId: 'threadnote',
          manifestPath: '/unused/threadnote.json',
          user: 'tester',
        },
        {
          item: {
            ...finding.caseIdentity!,
            caseId: finding.caseId!,
            evidenceRevision: 'test-revision',
            disposition: 'needs-decision',
            reason: finding.summary,
            firstSeen: now.toISOString(),
            lastSeen: now.toISOString(),
            lastChecked: now.toISOString(),
            attemptCount: 0,
            events: [],
            subjectContentHashes: records.map(record => ({
              uri: record.uri,
              hash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
            })),
          },
          record: records[0],
          corpus: records,
          callerCwd: '/unused',
        },
        Effect.sync(() => {
          revisionChecks += 1;
        }),
      );
      expect(revisionChecks).toBe(2);
      expect(packet.semanticEvidence).toEqual(finding.semanticEvidence);
      expect(packet.semanticEvidence?.reason).toBe('policy-conflict');
      expect(packet.semanticEvidence?.left.context.headings).toEqual(['Production']);
      expect(packet.choices.join(' ')).not.toContain('Choose the current assertion');
      expect(renderContextHealth(report)).toContain('Timeout must be 30 seconds.');
      expect(renderContextHealth(report)).toContain('policy-conflict');
      const plan = previewContextHealthRepairPlanV1(report, records);
      expect(plan.proposals).toEqual([
        expect.objectContaining({mutation: expect.objectContaining({kind: 'review-only'})}),
      ]);
      expect(plan.proposals[0].preconditions).toEqual([]);
      expect(records).toEqual(original);
    }).pipe(
      provideTestLayer(
        Layer.mergeAll(
          StandaloneBrokerLayer,
          CodeGraphLanguagePackRegistry.layer,
          Layer.mock(CodeGraphQueryService, {}),
          Layer.mock(CodeGraphStore, {}),
        ),
      ),
    ),
  );
  it('changes maintenance case evidence identity after scope or source revision edits', () => {
    const report = (corpus: readonly MemoryRecord[]) =>
      buildContextHealthReport({project: 'threadnote', records: corpus, now});
    const first = report(records).findings[0];
    const changed = memory('a', '# Production\nTimeout is 60 seconds.\nAdditional source context.');
    expect(
      report([changed, records[1]]).findings.find(item => item.category === 'semantic-contradiction')?.caseId,
    ).not.toBe(first.caseId);
    expect(
      report([memory('a', '# Local\nTimeout is 60 seconds.'), records[1]]).findings.filter(
        item => item.category === 'semantic-contradiction',
      ),
    ).toEqual([]);
  });
});
