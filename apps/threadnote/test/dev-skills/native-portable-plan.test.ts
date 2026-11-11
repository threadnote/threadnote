import {describe, expect, it} from 'vitest';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {
  canonicalAuthoringJson,
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  nativeSpecIntentDigest,
} from '@threadnote/workflow-automations/authoring';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {
  decodePortablePlanPages,
  decodePortablePlanPayload,
  decodePortablePlanRef,
  encodePortablePlanPages,
  encodePortablePlanRef,
} from '../../src/workflow_automation/portable_plan.js';

const h = (value: string) => sha256HexSync(value);
const ref = (name: string, content: string) => ({
  uri: `threadnote://user/alice/memories/shared/team/durable/projects/project/${name}.md`,
  memoryId: `tn_${pipe(h(name), EffectString.slice(0, 24))}`,
  revision: h(content),
});
const plan = decodeNativeAuthoringDocument({
  format: 'threadnote-native-authoring',
  schemaVersion: 1,
  id: 'feature',
  project: 'project',
  title: 'Fixture plan',
  objective: 'Preserve one fixture behavior.',
  requirements: [{id: 'r', behavior: 'The behavior is preserved.'}],
  context: {codeRefs: [], evidenceRefs: [], note: 'Synthetic fixture.'},
  source: null,
  sourceFreeReason: 'The fixture has no source files.',
  kind: 'plan',
  current: {summary: 'The behavior is absent.', components: [], contracts: [], diagram: ''},
  target: {summary: 'The behavior exists.', components: [], contracts: [], diagram: ''},
  phases: [
    {
      id: 'phase',
      title: 'Implement behavior',
      outcome: 'The behavior exists.',
      dependsOn: [],
      affectedPaths: [],
      newPaths: [],
      contracts: [],
      safeBoundary: 'The fixture remains isolated.',
      acceptance: [
        {id: 'a', criterion: 'The behavior works.', verification: 'Run the fixture.', requirementIds: ['r']},
      ],
    },
  ],
  decisions: [],
  openQuestions: [],
  review: {required: true, reason: 'Review fixture.'},
});
if (plan.kind !== 'plan') throw new Error('Invalid fixture');
const planText = canonicalAuthoringJson(plan);
const payload = {
  format: 'threadnote-portable-plan',
  version: 1,
  project: 'project',
  plan: {document: planText, documentHash: nativeAuthoringDigest(plan)},
  evidence: [],
  provenance: {
    root: ref('donor', 'donor'),
    documentHash: nativeAuthoringDigest(plan),
    intentHash: nativeSpecIntentDigest(plan, 2),
    review: {outcome: 'accepted', blockingIssueCount: 0},
    approval: 'approved',
  },
} as const;
const body = stableJson(payload);
const root = {
  format: 'threadnote-portable-plan-root',
  version: 1,
  project: 'project',
  team: 'team',
  payloadHash: h(body),
  pages: [{reference: ref('page', body), contentHash: h(body)}],
} as const;

describe('portable plan admission', () => {
  it('admits a complete hash-pinned page and rejects scope, missing, changed and malformed content', () => {
    const pages = [{reference: root.pages[0].reference, content: body}];
    expect(decodePortablePlanPages(root, pages, {team: 'team', project: 'project'}).plan).toEqual(plan);
    for (const change of [
      () => decodePortablePlanPages(root, pages, {team: 'other', project: 'project'}),
      () => decodePortablePlanPages(root, [], {team: 'team', project: 'project'}),
      () => decodePortablePlanPages(root, [{...pages[0], content: body + ' '}], {team: 'team', project: 'project'}),
      () => decodePortablePlanPages(root, [{...pages[0], content: '{'}], {team: 'team', project: 'project'}),
      () => decodePortablePlanPayload({...payload, spec: {document: planText, documentHash: h(planText)}}),
    ])
      expect(change).toThrow();
  });

  it('rejects oversized pages without inspecting their content', () => {
    expect(() =>
      decodePortablePlanPages(
        root,
        [{reference: root.pages[0].reference, content: pipe('x', EffectString.repeat(24_001))}],
        {
          team: 'team',
          project: 'project',
        },
      ),
    ).toThrow();
  });

  it('splits a canonical snapshot and round-trips a user-independent reference', () => {
    expect(EffectArray.join(encodePortablePlanPages(payload), '')).toBe(body);
    const reference = encodePortablePlanRef({version: 1, team: 'team', project: 'project', payloadHash: h(body)});
    expect(decodePortablePlanRef(reference).payloadHash).toBe(h(body));
    expect(() => decodePortablePlanRef(reference + 'A')).toThrow();
  });

  it('retains a complete multibyte document across bounded pages', () => {
    const expandedPlan = decodeNativeAuthoringDocument({
      ...plan,
      current: {
        ...plan.current,
        components: Array.from(
          {length: 30},
          (_, index) => `Component ${index} ${pipe('🌊', EffectString.repeat(200))}`,
        ),
      },
    });
    if (expandedPlan.kind !== 'plan') throw new Error('Invalid fixture');
    const expanded = {
      ...payload,
      plan: {document: canonicalAuthoringJson(expandedPlan), documentHash: nativeAuthoringDigest(expandedPlan)},
      provenance: {
        ...payload.provenance,
        documentHash: nativeAuthoringDigest(expandedPlan),
        intentHash: nativeSpecIntentDigest(expandedPlan, 2),
      },
    };
    const chunks = encodePortablePlanPages(expanded);
    expect(chunks.length).toBeGreaterThan(1);
    expect(EffectArray.join(chunks, '')).toBe(stableJson(expanded));
    expect(EffectArray.every(chunks, chunk => new TextEncoder().encode(chunk).byteLength <= 24_000)).toBe(true);
  });
});
