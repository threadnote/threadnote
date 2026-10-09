import {DateTime, Effect} from 'effect';
import {parseResourceId, resourceIdIsWithin} from '@threadnote/store/resource-id';
import {readSourceEvidence, serializeSourceEvidenceCitation} from '@threadnote/store/source-evidence';
import {resourceStoreLocation} from '../../memory/migrations.js';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  captureObsidianEvidence,
  discardObsidianEvidence,
  inspectObsidianNote,
  readObsidianEvidence,
} from '@threadnote/integration-obsidian/source';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {readMemoryRecordsByUri, writeDurableMemory} from './memory.js';
import {
  argumentError,
  mcpErrorResult,
  requiredText,
  type RuntimeConfig,
  uriSegment,
  withStaleVersionNotice,
} from './common.js';

export function registerObsidianEvidenceTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'inspect_obsidian_note',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Read one live, synced sanitized Obsidian note with source instance, note ID, sanitizer version and revision hash. Pass that identity to derive_from_obsidian after review.',
      inputSchema: {
        sourceId: McpInput.string('Configured Obsidian source ID'),
        relativePath: McpInput.string('Vault-relative Markdown note path'),
      },
    },
    ({sourceId, relativePath}) => {
      const id = requiredText(sourceId, 'inspect_obsidian_note', 'sourceId', {sourceId: 'engineering'});
      if (!id.ok) return id.error;
      const notePath = requiredText(relativePath, 'inspect_obsidian_note', 'relativePath', {
        relativePath: 'Engineering/Decision.md',
      });
      if (!notePath.ok) return notePath.error;
      return inspectObsidianNote(config, id.value, notePath.value).pipe(
        Effect.map(note => ({
          content: [
            {
              type: 'text' as const,
              text: [
                'OBSIDIAN SANITIZED REVISION',
                `sourceId: ${note.sourceId}`,
                `relativePath: ${note.relativePath}`,
                `sourceInstanceId: ${note.sourceInstanceId}`,
                `noteId: ${note.noteId}`,
                `revisionHash: ${note.revisionHash}`,
                `sanitizerVersion: ${note.sanitizerVersion}`,
                '',
                'SANITIZED NOTE',
                note.sanitizedContent,
              ].join('\n'),
            },
          ],
          structuredContent: {
            type: 'threadnote-obsidian-revision',
            version: 1,
            sourceId: note.sourceId,
            sourceInstanceId: note.sourceInstanceId,
            noteId: note.noteId,
            relativePath: note.relativePath,
            revisionHash: note.revisionHash,
            sanitizerVersion: note.sanitizerVersion,
          },
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
        Effect.flatMap(withStaleVersionNotice),
      );
    },
  );

  server.registerTool(
    'derive_from_obsidian',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Accept a private durable memory derived from one synced Obsidian note. Pin the exact sanitized revision and a supporting fragment for 90 days by default (1–365 days).',
      inputSchema: {
        sourceId: McpInput.string('Configured Obsidian source ID'),
        relativePath: McpInput.string('Vault-relative Markdown note path'),
        fragment: McpInput.string('Exact supporting text from the sanitized imported note; at most 8192 UTF-8 bytes'),
        expectedSourceInstanceId: McpInput.string('Source instance from inspect_obsidian_note'),
        expectedNoteId: McpInput.string('Note ID from inspect_obsidian_note'),
        expectedRevisionHash: McpInput.string('Sanitized SHA-256 from inspect_obsidian_note'),
        expectedSanitizerVersion: McpInput.string('Sanitizer contract from inspect_obsidian_note'),
        text: McpInput.string('Reviewed derived memory prose'),
        project: McpInput.string('Memory project'),
        topic: McpInput.string('Stable memory topic'),
        retentionDays: McpInput.integer('Retention from acceptance, 1–365 days; default 90', {
          minimum: 1,
          maximum: 365,
        }),
      },
    },
    ({
      sourceId,
      relativePath,
      fragment,
      expectedSourceInstanceId,
      expectedNoteId,
      expectedRevisionHash,
      expectedSanitizerVersion,
      text,
      project,
      topic,
      retentionDays,
    }) => {
      const fields = [
        requiredText(sourceId, 'derive_from_obsidian', 'sourceId', {sourceId: 'engineering'}),
        requiredText(relativePath, 'derive_from_obsidian', 'relativePath', {relativePath: 'Engineering/Decision.md'}),
        requiredText(expectedSourceInstanceId, 'derive_from_obsidian', 'expectedSourceInstanceId', {
          expectedSourceInstanceId: 'source-instance-id',
        }),
        requiredText(expectedNoteId, 'derive_from_obsidian', 'expectedNoteId', {expectedNoteId: 'note-id'}),
        requiredText(expectedRevisionHash, 'derive_from_obsidian', 'expectedRevisionHash', {
          expectedRevisionHash: 'sanitized-sha256',
        }),
        requiredText(expectedSanitizerVersion, 'derive_from_obsidian', 'expectedSanitizerVersion', {
          expectedSanitizerVersion: 'scrubber-redact-v1',
        }),
        requiredText(text, 'derive_from_obsidian', 'text', {text: 'Reviewed decision...'}),
        requiredText(project, 'derive_from_obsidian', 'project', {project: 'threadnote'}),
        requiredText(topic, 'derive_from_obsidian', 'topic', {topic: 'decision'}),
      ];
      const invalid = fields.find(field => !field.ok);
      if (invalid && !invalid.ok) return invalid.error;
      return Effect.gen(function* () {
        const [
          checkedSourceId,
          checkedPath,
          checkedInstance,
          checkedNoteId,
          checkedRevision,
          checkedSanitizer,
          checkedText,
          checkedProject,
          checkedTopic,
        ] = fields.map(field => (field.ok ? field.value : ''));
        if (typeof fragment !== 'string' || fragment.length === 0)
          return argumentError('derive_from_obsidian needs an exact non-empty fragment.');
        const citation = yield* captureObsidianEvidence(config, {
          sourceId: checkedSourceId,
          relativePath: checkedPath,
          fragment,
          expectedSourceInstanceId: checkedInstance,
          expectedNoteId: checkedNoteId,
          expectedRevisionHash: checkedRevision,
          expectedSanitizerVersion: checkedSanitizer,
          retentionDays,
        });
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        let canonicalWriteStarted = false;
        const result = yield* writeDurableMemory(config, {
          bodyText: checkedText,
          metadata: {
            kind: 'durable',
            obsidianEvidence: citation,
            project: checkedProject,
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'mcp',
            status: 'active',
            timestamp,
            topic: checkedTopic,
            visibility: 'personal',
          },
          operation: 'create',
          onCanonicalWriteStarted: () => {
            canonicalWriteStarted = true;
          },
        }).pipe(
          Effect.onError(() =>
            canonicalWriteStarted ? Effect.void : discardObsidianEvidence(config, citation).pipe(Effect.ignore),
          ),
        );
        if (result.isError === true && !canonicalWriteStarted) yield* discardObsidianEvidence(config, citation);
        return result;
      }).pipe(
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
        Effect.flatMap(withStaleVersionNotice),
      );
    },
  );

  server.registerTool(
    'read_source_evidence',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Read the exact retained supporting fragment for a private memory derived from a configured integration. Availability follows current local source access and synced permission receipts, not live remote permission checks. A matching current revision does not validate the derived claim.',
      inputSchema: {
        memoryUri: McpInput.string('Private memory URI returned by derive_from_source or derive_from_obsidian'),
      },
    },
    ({memoryUri}) => {
      const checked = requiredText(memoryUri, 'read_source_evidence', 'memoryUri', {
        memoryUri: 'threadnote://user/example/memories/durable/projects/example/decision.md',
      });
      if (!checked.ok) return checked.error;
      return Effect.gen(function* () {
        const canonical = yield* Effect.try({
          try: () => parseResourceId(checked.value).canonicalUri,
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        if (!canonical) {
          return argumentError('read_source_evidence requires a canonical private memory URI.');
        }
        const personalRoot = `threadnote://user/${uriSegment(config.user)}/memories`;
        if (!resourceIdIsWithin(canonical, personalRoot) || canonical.includes('/memories/shared/')) {
          return argumentError('read_source_evidence is restricted to private local memories.');
        }
        const [record] = yield* readMemoryRecordsByUri(config, [canonical]);
        if (!record) return argumentError('Memory is unavailable.');
        if (record.metadata.sourceEvidenceError)
          return argumentError('Memory has malformed source evidence citation metadata.');
        if (record.metadata.obsidianEvidenceError)
          return argumentError('Memory has malformed Obsidian evidence citation metadata.');
        if (!record.metadata.sourceEvidence && !record.metadata.obsidianEvidence)
          return argumentError('Memory has no source evidence citation.');
        const evidence = yield* record.metadata.sourceEvidence
          ? readSourceEvidence(resourceStoreLocation(config), record.metadata.sourceEvidence)
          : readObsidianEvidence(config, record.metadata.obsidianEvidence!);
        const description =
          evidence.historical === 'available'
            ? `Historical supporting fragment (${evidence.currentRevision} current sanitized revision; claim applicability unverified):\n\n${evidence.fragment}`
            : `Historical evidence ${evidence.historical}; current revision unknown; claim applicability unverified.`;
        return {
          content: [
            {
              type: 'text' as const,
              text: record.metadata.sourceEvidence
                ? `${description}\n\nSOURCE EVIDENCE CITATION\n${serializeSourceEvidenceCitation(record.metadata.sourceEvidence)}`
                : description,
            },
          ],
          structuredContent: {
            type: record.metadata.sourceEvidence ? 'threadnote-source-evidence' : 'threadnote-obsidian-evidence',
            version: 1,
            memoryUri: canonical,
            ...evidence,
          },
        };
      }).pipe(
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
        Effect.flatMap(withStaleVersionNotice),
      );
    },
  );
}
