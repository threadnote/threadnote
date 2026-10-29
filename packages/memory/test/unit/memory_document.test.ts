import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  boundedMemoryAuthority,
  boundedMemoryTrust,
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  inferMemoryMetadata,
  isAgentArtifactUri,
  isAgentArtifactPath,
  isIsoDateOrCanonicalIsoInstant,
  memoryHeaderValue,
  parseMemoryDocument,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {
  assertMemorySchemaWritable,
  createMemoryCodeCitation,
  formatMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
  MAX_SUPPORTED_MEMORY_SCHEMA_VERSION,
  UnsupportedMemorySchemaVersionError,
  type MemoryCodeCitationInputV1,
} from '@threadnote/memory/code/citation';
import {migrateMemoryDocumentV4ToV5} from '@threadnote/memory/migrations';
import {isJsonObject} from '@threadnote/platform/json';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object.');
  return value;
}

describe('memory document contract', () => {
  it('recognizes reserved artifact roots without treating a basename or nested directory as an artifact', () => {
    for (const relative of [
      'agent-artifacts',
      'agent-artifacts/skills/claude/review-pr/SKILL.md',
      'shared/default/agent-artifacts/packs/team/README.md',
    ]) {
      expect(isAgentArtifactUri(`threadnote://user/tester/memories/${relative}`)).toBe(true);
      expect(isAgentArtifactUri(`viking://user/tester/memories/${relative}`)).toBe(true);
    }
    for (const relative of [
      'durable/projects/test/SKILL.md',
      'durable/agent-artifacts/bad.md',
      'agent-artifacts-old/bad.md',
      'shared/agent-artifacts/bad.md',
    ])
      expect(isAgentArtifactUri(`threadnote://user/tester/memories/${relative}`)).toBe(false);
    expect(isAgentArtifactUri('file:///memories/agent-artifacts/skill.md')).toBe(false);
    expect(isAgentArtifactPath(['agent-artifacts', 'skills', 'local?tool'])).toBe(true);
    expect(isAgentArtifactPath(['shared', 'default', 'agent-artifacts', 'local?tool'])).toBe(true);
    expect(isAgentArtifactPath(['durable', 'agent-artifacts', 'tool'])).toBe(false);
  });

  it('projects constructed headers independently of field order, duplicates, empties and line endings (property)', () => {
    const citation = createMemoryCodeCitation(citationInput('src/header-property.ts'));
    const encoded = formatMemoryCodeCitation(citation);
    const optionalScalar = fc.option(fc.constantFrom('', 'first-value'), {nil: undefined});
    fc.assert(
      fc.property(
        fc.record({
          title: fc.constantFrom('MEMORY' as const, 'HANDOFF' as const),
          emptyKind: fc.boolean(),
          candidate: fc.constantFrom('', 'first-candidate'),
          agent: optionalScalar,
          timestamp: fc.option(fc.constantFrom('', '2026-10-04T00:00:00.000Z'), {nil: undefined}),
          project: optionalScalar,
          repo: optionalScalar,
          topic: optionalScalar,
          keywords: fc.array(fc.constantFrom('', 'one', 'β', 'one'), {maxLength: 6}),
          schema: fc.constantFrom('canonical', 'duplicate', 'spaced'),
          citation: fc.constantFrom('canonical', 'extra-space', 'indented', 'missing-space'),
          ending: fc.constantFrom('\n', '\r\n', '\r'),
          footer: fc.boolean(),
          order: fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6], {minLength: 7, maxLength: 7}),
        }),
        input => {
          const kind = input.title === 'HANDOFF' && input.emptyKind ? 'handoff' : 'durable';
          const citationLine = {
            canonical: `code_citation: ${encoded}`,
            'extra-space': `code_citation:  ${encoded}`,
            indented: ` code_citation: ${encoded}`,
            'missing-space': `code_citation:${encoded}`,
          }[input.citation];
          const groups = [
            [
              `candidate_id: ${input.candidate}`,
              'candidate_id: ignored',
              ...(input.agent === undefined
                ? []
                : [`source_agent_client: ${input.agent}`, 'source_agent_client: ignored']),
              ...(input.timestamp === undefined ? [] : [`timestamp: ${input.timestamp}`, 'timestamp: ignored']),
            ],
            [
              ...(input.project === undefined ? [] : [`project: ${input.project}`, 'project: ignored']),
              ...(input.repo === undefined ? [] : [`repo: ${input.repo}`, 'repo: ignored']),
              'repo_path: legacy-path',
            ],
            [...(input.topic === undefined ? [] : [`topic: ${input.topic}`, 'topic: ignored']), 'task: legacy-task'],
            EffectArray.map(input.keywords, value => `keywords: ${value}`),
            [
              `schema_version: ${input.schema === 'spaced' ? ' ' : ''}${MEMORY_SCHEMA_VERSION}`,
              ...(input.schema === 'duplicate' ? [`schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`] : []),
            ],
            [citationLine],
            [`kind: ${kind === 'handoff' ? '' : 'durable'}`, 'kind: preference', 'status: active'],
          ];
          const header = [input.title, ...EffectArray.flatMap(input.order, index => groups[index])];
          const body = 'Payload remains readable.\nproject: body-only\nkeywords: hidden';
          const raw = EffectArray.join(
            [
              ...header,
              '',
              ...Effect.pipe(body, EffectString.split('\n')),
              ...(input.footer ? ['', '<!-- MEMORY_FIELDS', 'version: 1', '-->'] : []),
            ],
            input.ending,
          );
          const uri = 'threadnote://user/me/memories/durable/projects/headers/property.md';
          const parsed = parseMemoryDocument(uri, raw)!;
          const inferred = inferMemoryMetadata(raw);
          const project = input.project ?? input.repo;
          const keywords = EffectArray.filter(input.keywords, value => value !== '');
          const errors = [
            ...(input.schema === 'canonical' ? [] : [{reason: 'schema-version-mismatch'}]),
            ...(input.citation === 'canonical' ? [] : [{index: 0, reason: 'non-canonical'}]),
          ];
          const common = {
            kind,
            candidateId: input.candidate,
            keywords: keywords.length === 0 ? undefined : keywords,
            schemaVersion: MEMORY_SCHEMA_VERSION,
            codeCitations: input.citation === 'canonical' ? [citation] : undefined,
            citationErrors: errors.length === 0 ? undefined : errors,
            status: 'active',
          };
          expect(parsed.metadata).toMatchObject({
            ...common,
            project: project || undefined,
            topic: input.topic || undefined,
            sourceAgentClient: input.agent ?? 'unknown',
            timestamp: input.timestamp ?? new Date(0).toISOString(),
          });
          expect(inferred).toMatchObject({
            ...common,
            project: (project ?? 'legacy-path') || undefined,
            topic: (input.topic ?? 'legacy-task') || undefined,
            sourceAgentClient: input.agent,
            timestamp: input.timestamp,
          });
          expect(memoryHeaderValue(EffectArray.join(header, '\n'), 'candidate_id')).toBe(input.candidate);
          expect(parsed.headerTitle).toBe(input.title);
          expect(parsed.body).toBe(body);
          expect(parsed.content).toBe(raw);
          expect(parsed.uri).toBe(uri);
        },
      ),
      {numRuns: 80, seed: 110411},
    );
  });

  it('preserves the legacy document format when versioned metadata is absent', () => {
    const metadata: MemoryMetadata = {
      kind: 'durable',
      project: 'threadnote',
      references: ['threadnote://resources/repos/threadnote/README.md'],
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-07-23T10:00:00.000Z',
      topic: 'recall',
    };

    const document = formatMemoryDocument('MEMORY', metadata, 'Use the shared ranker.');

    expect(document).toBe(
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: recall',
          'source_agent_client: codex',
          'timestamp: 2026-07-23T10:00:00.000Z',
          'references: threadnote://resources/repos/threadnote/README.md',
          '',
          'Use the shared ranker.',
        ],
        '\n',
      ),
    );
    expect(parseMemoryDocument('threadnote://user/me/memory.md', document)?.metadata).toEqual(metadata);
  });

  it('parses LF, CRLF, and CR legacy bodies equivalently without normalizing canonical content bytes', () => {
    const lf = EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: newline-compatibility',
        'schema_version: 1',
        '',
        'Legacy body remains nonempty.',
        'Second line remains available to recall.',
      ],
      '\n',
    );
    const variants = [
      lf,
      Effect.pipe(lf, EffectString.replaceAll('\n', '\r\n')),
      Effect.pipe(lf, EffectString.replaceAll('\n', '\r')),
    ];

    for (const content of variants) {
      const parsed = parseMemoryDocument('threadnote://user/me/newline-compatibility.md', content);
      expect(parsed?.body).toBe('Legacy body remains nonempty.\nSecond line remains available to recall.');
      expect(parsed?.metadata).toMatchObject({
        kind: 'durable',
        project: 'threadnote',
        schemaVersion: 1,
        status: 'active',
        topic: 'newline-compatibility',
      });
      expect(parsed?.content).toBe(content);
      expect(inferMemoryMetadata(content)).toMatchObject({
        kind: 'durable',
        project: 'threadnote',
        schemaVersion: 1,
        status: 'active',
        topic: 'newline-compatibility',
      });
    }
    expect(canonicalMemoryDocumentContent(variants[1])).not.toBe(canonicalMemoryDocumentContent(lf));
    expect(canonicalMemoryDocumentContent(variants[2])).not.toBe(canonicalMemoryDocumentContent(lf));
  });

  it('round-trips authority, validity, provenance, evidence, and typed relations', () => {
    const metadata: MemoryMetadata = {
      authority: 'user_approved',
      candidateId: 'candidate-1',
      createdAt: '2026-07-23T10:00:00.000Z',
      evidence: ['session:turn-12', 'commit:abc123'],
      kind: 'durable',
      keywords: ['stalled worker recovery', 'lease renewal'],
      lastReviewed: '2026-07-23T10:10:00.000Z',
      memoryId: 'tn_01k0example',
      project: 'threadnote',
      relations: [
        {type: 'depends_on', uri: 'threadnote://resources/repos/threadnote/docs/effect.md'},
        {type: 'supersedes', uri: 'threadnote://user/me/memories/old.md'},
      ],
      schemaVersion: 2,
      sourceHash: 'sha256:abc123',
      sourceAgentClient: 'codex',
      sourceCommit: 'abc123',
      sourceObservedAt: '2026-07-23T10:00:00.000Z',
      sourceSessionId: 'session-1',
      status: 'active',
      timestamp: '2026-07-23T10:11:00.000Z',
      topic: 'recall',
      trust: 'approved',
      updatedAt: '2026-07-23T10:11:00.000Z',
      validFrom: '2026-07-23T00:00:00.000Z',
      validTo: '2027-07-23T00:00:00.000Z',
      visibility: 'personal',
      workspaceScope: 'packages/recall',
    };

    const document = formatMemoryDocument('MEMORY', metadata, 'Effect workflows compose upward.');
    const parsed = parseMemoryDocument('threadnote://user/me/memory.md', document);

    expect(parsed?.metadata).toEqual(metadata);
    expect(parsed?.body).toBe('Effect workflows compose upward.');
  });

  it('round-trips canonical schema-v4 file and symbol citations without persisting validation state', () => {
    const file = createMemoryCodeCitation(citationInput('apps/threadnote/src/memory/index.ts'));
    const symbol = createMemoryCodeCitation({
      ...citationInput('apps/threadnote/src/context_brief/memory_evidence.ts'),
      target: {
        fragmentCanonicalization: 'utf8-source-span-v1',
        fragmentHash: hash('b'),
        kind: 'symbol',
        language: 'typescript',
        name: 'validateContextBriefPreciseCodeEvidence',
        nodeId: `cgs_${Effect.pipe('c', EffectString.repeat(40))}`,
        qualifiedName: 'validateContextBriefPreciseCodeEvidence',
        signatureHash: hash('d'),
        span: {column: 1, endColumn: 2, endLine: 63, line: 43},
        symbolKind: 'function',
      },
    });
    const metadata: MemoryMetadata = {
      codeCitations: [file, symbol],
      kind: 'durable',
      project: 'threadnote',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-08-26T20:00:00.000Z',
      topic: 'citation-contract',
    };

    const document = formatMemoryDocument('MEMORY', metadata, 'Precise evidence supersedes commit-only freshness.');
    const parsed = parseMemoryDocument('threadnote://user/me/memory.md', document);
    const fileWire = requireJsonObject(JSON.parse(formatMemoryCodeCitation(file)));

    expect(file.id).toBe('tncc_14b8d7c2ff2c496c2a70dd2576a6874e03865334');
    expect(EffectRecord.keys(fileWire)).toEqual([
      'version',
      'id',
      'repositoryId',
      'repositoryIdentityKind',
      'sourceCommit',
      'sourceSnapshotId',
      'sourceDirty',
      'sourceGraphContentId',
      'extractorSet',
      'path',
      'fileContentHash',
      'target',
    ]);
    expect(document).toContain(`\ncode_citation: ${formatMemoryCodeCitation(file)}\n`);
    expect(document).toContain(`\ncode_citation: ${formatMemoryCodeCitation(symbol)}\n`);
    expect(formatMemoryCodeCitation(symbol)).toMatch(
      /^\{"version":1,"id":"tncc_[0-9a-f]{40}","repositoryId":.*,"target":\{"kind":"symbol","nodeId":.*,"fragmentCanonicalization":"utf8-source-span-v1"\}\}$/,
    );
    expect(parsed?.metadata.citationErrors).toBeUndefined();
    expect(parsed?.metadata.codeCitations).toEqual([file, symbol]);
    expect(Object.isFrozen(parsed?.metadata.codeCitations?.[1]?.target)).toBe(true);
    expect(parsed && formatMemoryDocument(parsed.headerTitle, parsed.metadata, parsed.body)).toBe(document);
    expect(inferMemoryMetadata(document).codeCitations).toEqual([file, symbol]);
  });

  it('round-trips v5 maintenance metadata while retaining v4 code-citation compatibility', () => {
    const citation = createMemoryCodeCitation(citationInput('src/memory/document.ts'));
    const v4 = formatMemoryDocument(
      'MEMORY',
      {
        codeCitations: [citation],
        kind: 'durable',
        project: 'threadnote',
        schemaVersion: 4,
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-09-17T10:00:00.000Z',
        topic: 'v4-compatibility',
      },
      'Existing citation evidence remains readable.',
    );
    const v5Metadata: MemoryMetadata = {
      codeCitations: [citation],
      kind: 'durable',
      owner: 'context-maintainers',
      project: 'threadnote',
      reviewAfter: '2026-12-01',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-09-17T10:00:00.000Z',
      topic: 'maintenance',
    };

    expect(parseMemoryDocument('threadnote://user/me/v4.md', v4)?.metadata.codeCitations).toEqual([citation]);
    const v5 = formatMemoryDocument('MEMORY', v5Metadata, 'Maintain this contract.');
    expect(v5).toContain('owner: context-maintainers');
    expect(v5).toContain('review_after: 2026-12-01');
    expect(parseMemoryDocument('threadnote://user/me/v5.md', v5)?.metadata).toEqual(v5Metadata);
  });

  it('migrates canonical v4 documents to v5 without inventing maintenance metadata', () => {
    const citation = createMemoryCodeCitation(citationInput('src/memory/document.ts'));
    const v4 = formatMemoryDocument(
      'MEMORY',
      {
        codeCitations: [citation],
        kind: 'durable',
        project: 'threadnote',
        schemaVersion: 4,
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-09-17T10:00:00.000Z',
      },
      'Migrate only the schema version.',
    );

    const migrated = migrateMemoryDocumentV4ToV5(v4);
    const parsed = parseMemoryDocument('threadnote://user/me/migrated.md', migrated);

    expect(migrated).toBe(Effect.pipe(v4, EffectString.replace('schema_version: 4', 'schema_version: 5')));
    expect(migrateMemoryDocumentV4ToV5(migrated)).toBe(migrated);
    expect(parsed?.metadata).toMatchObject({codeCitations: [citation], schemaVersion: 5});
    expect(parsed?.metadata.owner).toBeUndefined();
    expect(parsed?.metadata.reviewAfter).toBeUndefined();
  });

  it('has a deterministic, idempotent v4-to-v5 migration that never adds maintenance metadata (property)', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 256}), body => {
        const v4 = EffectArray.join(
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            'source_agent_client: codex',
            'timestamp: 2026-09-17T10:00:00.000Z',
            'schema_version: 4',
            '',
            body,
          ],
          '\n',
        );

        const migrated = migrateMemoryDocumentV4ToV5(v4);
        const parsed = parseMemoryDocument('threadnote://user/me/property.md', migrated);

        expect(migrateMemoryDocumentV4ToV5(v4)).toBe(migrated);
        expect(migrateMemoryDocumentV4ToV5(migrated)).toBe(migrated);
        expect(parsed?.metadata.schemaVersion).toBe(5);
        expect(parsed?.metadata.owner).toBeUndefined();
        expect(parsed?.metadata.reviewAfter).toBeUndefined();
        expect(parsed?.body).toBe(Effect.pipe(body, EffectString.replace(/\r\n?/gu, '\n'), EffectString.trim));
      }),
      {numRuns: 64},
    );
  });

  it('rejects non-calendar review_after values while keeping malformed imported values non-authoritative', () => {
    const metadata: MemoryMetadata = {
      kind: 'durable',
      reviewAfter: '2026-02-30',
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-09-17T10:00:00.000Z',
    };

    expect(() => formatMemoryDocument('MEMORY', metadata, 'Body')).toThrow('review_after must be an ISO date');
    expect(
      parseMemoryDocument(
        'threadnote://user/me/invalid-review-date.md',
        EffectArray.join(['MEMORY', 'kind: durable', 'status: active', 'review_after: 2026-02-30', '', 'Body'], '\n'),
      )?.metadata.reviewAfter,
    ).toBeUndefined();
  });

  it('validates four-digit ISO calendar years without Date.UTC century coercion', () => {
    expect(isIsoDateOrCanonicalIsoInstant('0000-02-29')).toBe(true);
    expect(isIsoDateOrCanonicalIsoInstant('0099-12-31')).toBe(true);
    expect(isIsoDateOrCanonicalIsoInstant('0000-02-30')).toBe(false);
    expect(isIsoDateOrCanonicalIsoInstant('0099-02-29')).toBe(false);
    expect(isIsoDateOrCanonicalIsoInstant('0100-02-29')).toBe(false);
  });

  it('preserves closed errors for malformed, unsupported, and non-canonical schema-v4 citation lines', () => {
    const valid = formatMemoryCodeCitation(createMemoryCodeCitation(citationInput('src/valid.ts')));
    const {version: citationVersion, ...citationRest} = requireJsonObject(JSON.parse(valid));
    const reordered = JSON.stringify({...citationRest, version: citationVersion});
    const document = EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        `schema_version: ${MEMORY_SCHEMA_VERSION}`,
        'source_agent_client: codex',
        'timestamp: 2026-08-26T20:00:00.000Z',
        'code_citation: {not-json}',
        'code_citation: {"version":2}',
        `code_citation: ${reordered}`,
        `code_citation:  ${valid}`,
        `  code_citation: ${valid}`,
        '',
        'Body remains readable.',
      ],
      '\n',
    );

    const parsed = parseMemoryDocument('threadnote://user/me/malformed.md', document);

    expect(parsed?.body).toBe('Body remains readable.');
    expect(parsed?.metadata.codeCitations).toBeUndefined();
    expect(parsed?.metadata.citationErrors).toEqual([
      {index: 0, reason: 'invalid-json'},
      {index: 1, reason: 'unsupported-version'},
      {index: 2, reason: 'non-canonical'},
      {index: 3, reason: 'non-canonical'},
      {index: 4, reason: 'non-canonical'},
    ]);
    expect(inferMemoryMetadata(document).citationErrors).toEqual(parsed?.metadata.citationErrors);
    expect(() => parsed && formatMemoryDocument(parsed.headerTitle, parsed.metadata, parsed.body)).toThrow(
      'unresolved code-citation errors',
    );
  });

  it('keeps imported records readable while bounding citation count, entry bytes, and aggregate bytes', () => {
    const largeCitations = Array.from({length: MAX_MEMORY_CODE_CITATIONS + 1}, (_, index) =>
      createMemoryCodeCitation({
        ...citationInput(`src/${Effect.pipe('p', EffectString.repeat(3_400))}-${index}.ts`),
        extractorSet: Effect.pipe('e', EffectString.repeat(3_400)),
      }),
    );
    const document = EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        `schema_version: ${MEMORY_SCHEMA_VERSION}`,
        'source_agent_client: codex',
        'timestamp: 2026-08-26T20:00:00.000Z',
        ...EffectArray.map(largeCitations, citation => `code_citation: ${formatMemoryCodeCitation(citation)}`),
        '',
        'Imported body remains readable.',
      ],
      '\n',
    );

    const parsed = parseMemoryDocument('threadnote://user/me/oversized.md', document);

    expect(parsed?.body).toBe('Imported body remains readable.');
    expect(parsed?.metadata.codeCitations).toHaveLength(MAX_MEMORY_CODE_CITATIONS);
    expect(parsed?.metadata.citationErrors).toEqual([
      {index: MAX_MEMORY_CODE_CITATIONS, reason: 'too-many-citations'},
      {reason: 'aggregate-too-large'},
    ]);

    const oversizedEntry = Effect.pipe(
      document,
      EffectString.replace(
        /^code_citation: .*$/m,
        `code_citation: ${Effect.pipe('x', EffectString.repeat(8 * 1_024))}`,
      ),
    );
    expect(
      parseMemoryDocument('threadnote://user/me/entry.md', oversizedEntry)?.metadata.citationErrors,
    ).toContainEqual({
      index: 0,
      reason: 'entry-too-large',
    });
  });

  it('requires an exact schema-v4 header before treating a valid citation as authoritative', () => {
    const citation = createMemoryCodeCitation(citationInput('src/schema.ts'));
    const document = EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'schema_version: 4suffix',
        'source_agent_client: codex',
        'timestamp: 2026-08-26T20:00:00.000Z',
        `code_citation: ${formatMemoryCodeCitation(citation)}`,
        '',
        'Body',
      ],
      '\n',
    );

    const parsed = parseMemoryDocument('threadnote://user/me/schema.md', document);

    expect(parsed?.metadata.schemaVersion).toBeUndefined();
    expect(parsed?.metadata.codeCitations).toEqual([citation]);
    expect(parsed?.metadata.citationErrors).toEqual([{reason: 'schema-version-mismatch'}]);

    const spaced = parseMemoryDocument(
      'threadnote://user/me/schema-spaced.md',
      Effect.pipe(
        document,
        EffectString.replace('schema_version: 4suffix', `schema_version:  ${MEMORY_SCHEMA_VERSION}`),
      ),
    );
    expect(spaced?.metadata.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(spaced?.metadata.citationErrors).toEqual([{reason: 'schema-version-mismatch'}]);
  });

  it('fails closed on citation injection, duplicate/count bounds, and future-schema rewrites', () => {
    expect(() =>
      createMemoryCodeCitation({...citationInput('src/safe.ts'), path: 'src/safe.ts\nstatus: archived'}),
    ).toThrow('invalid shape');
    const citation = createMemoryCodeCitation(citationInput('src/safe.ts'));
    expect(() =>
      formatMemoryDocument(
        'MEMORY',
        {
          codeCitations: [citation, citation],
          kind: 'durable',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-26T20:00:00.000Z',
        },
        'Body',
      ),
    ).toThrow('unique derived identities');
    const tooMany = Array.from({length: MAX_MEMORY_CODE_CITATIONS + 1}, (_, index) =>
      createMemoryCodeCitation(citationInput(`src/file-${index}.ts`)),
    );
    expect(() =>
      formatMemoryDocument(
        'MEMORY',
        {
          codeCitations: tooMany,
          kind: 'durable',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-26T20:00:00.000Z',
        },
        'Body',
      ),
    ).toThrow(`at most ${MAX_MEMORY_CODE_CITATIONS}`);
    expect(() =>
      createMemoryCodeCitation({
        ...citationInput('src/large.ts'),
        extractorSet: Effect.pipe('x', EffectString.repeat(4_096)),
        path: `src/${Effect.pipe('p', EffectString.repeat(4_000))}`,
      }),
    ).toThrow('per-entry byte limit');
    expect(() => assertMemorySchemaWritable(MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1)).toThrow(
      UnsupportedMemorySchemaVersionError,
    );
    expect(() =>
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          schemaVersion: MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-26T20:00:00.000Z',
        },
        'Future body',
      ),
    ).toThrow('newer than supported');
    expect(() =>
      formatMemoryDocumentWithKeywords(
        EffectArray.join(
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            `schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
            '',
            'Future body',
          ],
          '\n',
        ),
        ['must-not-rewrite'],
      ),
    ).toThrow('newer than supported');
    const legacyCrLf = EffectArray.join(
      ['MEMORY', 'kind: durable', 'status: active', 'schema_version: 1', '', 'Legacy CRLF body'],
      '\r\n',
    );
    expect(formatMemoryDocumentWithKeywords(legacyCrLf, ['safe-rewrite'])).toBe(
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'schema_version: 1',
          'keywords: safe-rewrite',
          '',
          'Legacy CRLF body',
        ],
        '\n',
      ),
    );
    for (const newline of ['\r\n', '\r']) {
      expect(() =>
        formatMemoryDocumentWithKeywords(
          EffectArray.join(
            [
              'MEMORY',
              'kind: durable',
              'status: active',
              `schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
              '',
              'Future line-ending body',
            ],
            newline,
          ),
          ['must-not-rewrite'],
        ),
      ).toThrow('newer than supported');
    }
    expect(() =>
      formatMemoryDocumentWithKeywords(
        EffectArray.join(
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            `  schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
            '',
            'Indented future body',
          ],
          '\n',
        ),
        ['must-not-rewrite'],
      ),
    ).toThrow('newer than supported');
    expect(() =>
      formatMemoryDocumentWithKeywords(
        EffectArray.join(
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            `schema_version: ${Effect.pipe('9', EffectString.repeat(80))}`,
            '',
            'Unsafe-version body',
          ],
          '\n',
        ),
        ['must-not-rewrite'],
      ),
    ).toThrow('canonical positive safe integer');
    expect(() =>
      formatMemoryDocumentWithKeywords(
        EffectArray.join(
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            `schema_version: ${MEMORY_SCHEMA_VERSION}`,
            `schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
            '',
            'Duplicate-version body',
          ],
          '\n',
        ),
        ['must-not-rewrite'],
      ),
    ).toThrow('must appear exactly once');
  });

  it('keeps enriched documents readable through the legacy header contract', () => {
    const document = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        keywords: ['stalled worker recovery', 'automatic task rescheduling'],
        project: 'orion-worker',
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-07-23T10:00:00.000Z',
        topic: 'lease-renewal',
      },
      'The coordinator renews worker leases after a stalled heartbeat.',
    );
    const legacyKnownHeaders = EffectRecord.fromEntries(
      EffectArray.map(
        EffectArray.filter(
          Effect.pipe(document, __effectPipeInput => {
            const __effectPipeStage0 = Effect.pipe(
              __effectPipeInput,
              EffectString.slice(
                0,
                Effect.pipe(
                  document,
                  EffectString.indexOf('\n\n'),
                  Effect.Option.getOrElse(() => -1),
                ),
              ),
            );
            const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.split('\n'));
            return __effectPipeStage1;
          }).slice(1),
          line => !Effect.pipe(line, EffectString.startsWith('keywords:')),
        ),
        line => {
          const separator = Effect.pipe(
            line,
            EffectString.indexOf(':'),
            Effect.Option.getOrElse(() => -1),
          );
          return [
            Effect.pipe(line, EffectString.slice(0, separator)),
            Effect.pipe(line, EffectString.slice(separator + 1), EffectString.trim),
          ];
        },
      ),
    );

    expect(legacyKnownHeaders).toMatchObject({
      kind: 'durable',
      project: 'orion-worker',
      source_agent_client: 'codex',
      status: 'active',
      topic: 'lease-renewal',
    });
    expect(Effect.pipe(document, EffectString.split('\n\n'))[1]).toBe(
      'The coordinator renews worker leases after a stalled heartbeat.',
    );
  });

  it('adds enrichment without dropping unknown headers or rewriting the body', () => {
    const original = EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'future_writer_field: preserve-me',
        'keywords: old alias',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T10:00:00.000Z',
        '',
        'Body spacing stays intact.',
        '',
        'Second paragraph.',
        '',
        '<!-- MEMORY_FIELDS',
        '{"version":1}',
        '-->',
      ],
      '\n',
    );

    const enriched = formatMemoryDocumentWithKeywords(original, ['new paraphrase', 'another alias']);

    expect(enriched).toContain('future_writer_field: preserve-me');
    expect(enriched).not.toContain('keywords: old alias');
    expect(enriched).toContain('keywords: new paraphrase\nkeywords: another alias');
    expect(EffectArray.join(Effect.pipe(enriched, EffectString.split('\n\n')).slice(1), '\n\n')).toBe(
      EffectArray.join(['Body spacing stays intact.', '', 'Second paragraph.'], '\n'),
    );
    expect(enriched).not.toContain('MEMORY_FIELDS');
  });

  it('excludes the legacy managed memory-fields trailer from the parsed body', () => {
    const document = EffectArray.join(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T10:00:00.000Z',
        '',
        'Only this text belongs to the memory body.',
        '',
        '<!-- MEMORY_FIELDS',
        '{',
        '  "version": 1',
        '}',
        '-->',
      ],
      '\n',
    );

    const parsed = parseMemoryDocument('threadnote://user/me/memory.md', document);

    expect(parsed?.body).toBe('Only this text belongs to the memory body.');
    expect(parsed?.content).toBe(document);
    expect(canonicalMemoryDocumentContent(document)).toBe(
      Effect.pipe(
        document,
        EffectString.slice(
          0,
          Effect.pipe(
            document,
            EffectString.indexOf('\n\n<!-- MEMORY_FIELDS'),
            Effect.Option.getOrElse(() => -1),
          ),
        ),
      ),
    );
  });

  it('accepts reviewed-candidate authority without allowing ordinary memories to self-elevate', () => {
    const uri = 'threadnote://user/me/memories/durable/projects/threadnote/recall.md';
    expect(boundedMemoryAuthority(uri, {authority: 'canonical_repo', trust: 'approved'})).toBe('agent_generated');
    expect(boundedMemoryTrust(uri, {authority: 'canonical_repo', trust: 'approved'})).toBe('inferred');
    const reviewed: Partial<MemoryMetadata> = {
      authority: 'user_approved',
      candidateId: 'candidate-1',
      lastReviewed: '2026-07-23T10:00:00.000Z',
      sourceObservedAt: '2026-07-23T09:59:00.000Z',
      trust: 'approved',
    };
    expect(boundedMemoryAuthority(uri, reviewed)).toBe('user_approved');
    expect(boundedMemoryTrust(uri, reviewed)).toBe('approved');
    const projectNamedShared = 'threadnote://user/me/memories/durable/projects/shared/topic.md';
    expect(boundedMemoryAuthority(projectNamedShared)).toBe('agent_generated');
    expect(boundedMemoryTrust(projectNamedShared)).toBe('inferred');
    const teamShared = 'threadnote://user/me/memories/shared/team/durable/projects/threadnote/topic.md';
    expect(boundedMemoryAuthority(teamShared)).toBe('reviewed_shared');
    expect(boundedMemoryTrust(teamShared)).toBe('approved');
    const importedResource = 'threadnote://resources/imports/external.md';
    expect(boundedMemoryAuthority(importedResource)).toBe('external');
    expect(boundedMemoryTrust(importedResource)).toBe('untrusted');
    expect(boundedMemoryAuthority(importedResource, undefined, {canonicalResource: true})).toBe('canonical_repo');
    expect(boundedMemoryTrust(importedResource, undefined, {canonicalResource: true})).toBe('approved');
  });

  it('rejects line breaks in scalar and repeated metadata headers', () => {
    const metadata: MemoryMetadata = {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'codex',
      sourceSessionId: 'session-1\ncandidate_id: injected',
      status: 'active',
      timestamp: '2026-07-23T10:00:00.000Z',
      topic: 'recall',
    };

    expect(() => formatMemoryDocument('MEMORY', metadata, 'Body')).toThrow(
      'Memory metadata source_session_id must not contain line breaks.',
    );
    expect(() =>
      formatMemoryDocument(
        'MEMORY',
        {...metadata, evidence: ['safe\nsupersedes: injected'], sourceSessionId: undefined},
        'Body',
      ),
    ).toThrow('Memory metadata evidence must not contain line breaks.');
  });

  it('ignores malformed and untyped relations', () => {
    const parsed = parseMemoryDocument(
      'threadnote://user/me/memory.md',
      EffectArray.join(
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          'source_agent_client: codex',
          'timestamp: 2026-07-23T10:00:00.000Z',
          'relation: unknown threadnote://user/me/other.md',
          'relation: related_to https://example.com',
          '',
          'Body',
        ],
        '\n',
      ),
    );

    expect(parsed?.metadata.relations).toBeUndefined();
  });

  it('infers legacy repo and task aliases', () => {
    expect(
      inferMemoryMetadata(
        EffectArray.join(
          ['HANDOFF', 'repo: threadnote', 'task: recall-quality', 'source_agent_client: claude', '', 'Body'],
          '\n',
        ),
      ),
    ).toMatchObject({
      kind: 'handoff',
      project: 'threadnote',
      sourceAgentClient: 'claude',
      topic: 'recall-quality',
    });
  });
});

function citationInput(path: string): MemoryCodeCitationInputV1 {
  return {
    extractorSet: 'native-code-graph-13',
    fileContentHash: hash('a'),
    path,
    repositoryId: Effect.pipe('1', EffectString.repeat(64)),
    repositoryIdentityKind: 'remote',
    sourceCommit: Effect.pipe('2', EffectString.repeat(40)),
    sourceDirty: false,
    sourceGraphContentId: `cgc_${Effect.pipe('3', EffectString.repeat(40))}`,
    sourceSnapshotId: `cgsn_${Effect.pipe('4', EffectString.repeat(40))}`,
    target: {kind: 'file'},
    version: 1,
  };
}

function hash(character: string): {readonly algorithm: 'sha256'; readonly value: string} {
  return {algorithm: 'sha256', value: Effect.pipe(character, EffectString.repeat(64))};
}
