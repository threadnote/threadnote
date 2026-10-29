import {Array as EffectArray} from 'effect';
import {DateTime, Effect} from 'effect';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  captureSourceEvidence,
  discardSourceEvidence,
  inspectSourceEvidence,
  serializeSourceEvidenceCitation,
} from '@threadnote/store/source-evidence';
import {resourceStoreLocation} from '../../memory/migrations.js';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {writeDurableMemory} from './memory.js';
import {argumentError, mcpErrorResult, requiredText, type RuntimeConfig, withStaleVersionNotice} from './common.js';
import * as EffectRecord from 'effect/Record';

export function registerSourceEvidenceTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  const location = resourceStoreLocation(config);
  server.registerTool(
    'inspect_source_evidence',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Review one eligible synced sanitized GitHub, Linear, Pocket or Superhuman Docs chunk. Returns exact source, access, renderer and revision identities for derive_from_source. Does not fetch or verify live remote permissions.',
      inputSchema: {resourceUri: McpInput.string('Canonical external chunk URI returned by source search or read')},
    },
    ({resourceUri}) => {
      const checked = requiredText(resourceUri, 'inspect_source_evidence', 'resourceUri', {
        resourceUri: 'threadnote://resources/external/pocket/reading/docs/item/pages/page/chunk.md',
      });
      if (!checked.ok) return checked.error;
      return inspectSourceEvidence(location, checked.value).pipe(
        Effect.map(inspection => ({
          content: [
            {
              type: 'text' as const,
              text: EffectArray.join(
                [
                  'SYNCED SANITIZED SOURCE REVISION',
                  ...EffectArray.map(
                    EffectArray.filter(EffectRecord.toEntries(inspection), ([key]) => key !== 'sanitizedContent'),
                    ([key, value]) => `${key}: ${value}`,
                  ),
                  '',
                  'SANITIZED CONTENT',
                  inspection.sanitizedContent,
                ],
                '\n',
              ),
            },
          ],
          structuredContent: {type: 'threadnote-source-revision', version: 1, ...inspection},
        })),
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
        Effect.flatMap(withStaleVersionNotice),
      );
    },
  );
  server.registerTool(
    'derive_from_source',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Accept a private durable memory from a reviewed GitHub, Linear, Pocket or Superhuman Docs chunk. Retain its exact sanitized supporting fragment for 90 days by default (1–365). Requires every identity from inspect_source_evidence; changed or inaccessible sources are rejected.',
      inputSchema: {
        resourceUri: McpInput.string('Canonical chunk URI from inspect_source_evidence'),
        fragment: McpInput.string('Exact supporting text from the reviewed sanitized chunk; at most 8192 UTF-8 bytes'),
        expectedSourceInstanceId: McpInput.string('Source instance from inspect_source_evidence'),
        expectedAccessHash: McpInput.string('Access hash from inspect_source_evidence'),
        expectedRevisionHash: McpInput.string('Sanitized SHA-256 from inspect_source_evidence'),
        expectedContentHash: McpInput.string('Envelope SHA-256 from inspect_source_evidence'),
        expectedRendererVersion: McpInput.string('Renderer version from inspect_source_evidence'),
        expectedSanitizerVersion: McpInput.string('Sanitizer version from inspect_source_evidence'),
        text: McpInput.string('Reviewed derived memory prose'),
        project: McpInput.string('Memory project'),
        topic: McpInput.string('Stable memory topic'),
        retentionDays: McpInput.integer('Retention from acceptance, 1–365 days; default 90', {
          minimum: 1,
          maximum: 365,
        }),
      },
    },
    ({fragment, retentionDays, ...input}) => {
      const resourceUri = requiredText(input.resourceUri, 'derive_from_source', 'resourceUri', {
        resourceUri: '<reviewed value>',
      });
      if (!resourceUri.ok) return resourceUri.error;
      const expectedSourceInstanceId = requiredText(
        input.expectedSourceInstanceId,
        'derive_from_source',
        'expectedSourceInstanceId',
        {expectedSourceInstanceId: '<reviewed value>'},
      );
      if (!expectedSourceInstanceId.ok) return expectedSourceInstanceId.error;
      const expectedAccessHash = requiredText(input.expectedAccessHash, 'derive_from_source', 'expectedAccessHash', {
        expectedAccessHash: '<reviewed value>',
      });
      if (!expectedAccessHash.ok) return expectedAccessHash.error;
      const expectedRevisionHash = requiredText(
        input.expectedRevisionHash,
        'derive_from_source',
        'expectedRevisionHash',
        {expectedRevisionHash: '<reviewed value>'},
      );
      if (!expectedRevisionHash.ok) return expectedRevisionHash.error;
      const expectedContentHash = requiredText(input.expectedContentHash, 'derive_from_source', 'expectedContentHash', {
        expectedContentHash: '<reviewed value>',
      });
      if (!expectedContentHash.ok) return expectedContentHash.error;
      const expectedRendererVersion = requiredText(
        input.expectedRendererVersion,
        'derive_from_source',
        'expectedRendererVersion',
        {expectedRendererVersion: '<reviewed value>'},
      );
      if (!expectedRendererVersion.ok) return expectedRendererVersion.error;
      const expectedSanitizerVersion = requiredText(
        input.expectedSanitizerVersion,
        'derive_from_source',
        'expectedSanitizerVersion',
        {expectedSanitizerVersion: '<reviewed value>'},
      );
      if (!expectedSanitizerVersion.ok) return expectedSanitizerVersion.error;
      const text = requiredText(input.text, 'derive_from_source', 'text', {text: '<reviewed value>'});
      if (!text.ok) return text.error;
      const project = requiredText(input.project, 'derive_from_source', 'project', {project: '<reviewed value>'});
      if (!project.ok) return project.error;
      const topic = requiredText(input.topic, 'derive_from_source', 'topic', {topic: '<reviewed value>'});
      if (!topic.ok) return topic.error;
      const checked = {
        resourceUri: resourceUri.value,
        expectedSourceInstanceId: expectedSourceInstanceId.value,
        expectedAccessHash: expectedAccessHash.value,
        expectedRevisionHash: expectedRevisionHash.value,
        expectedContentHash: expectedContentHash.value,
        expectedRendererVersion: expectedRendererVersion.value,
        expectedSanitizerVersion: expectedSanitizerVersion.value,
        text: text.value,
        project: project.value,
        topic: topic.value,
      };
      if (typeof fragment !== 'string' || fragment.length === 0)
        return argumentError('derive_from_source needs an exact non-empty fragment.');
      return Effect.gen(function* () {
        const citation = yield* captureSourceEvidence(location, {...checked, fragment, retentionDays});
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        let canonicalWriteStarted = false;
        const result = yield* writeDurableMemory(config, {
          bodyText: checked.text,
          metadata: {
            kind: 'durable',
            sourceEvidence: citation,
            project: checked.project,
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'mcp',
            status: 'active',
            timestamp,
            topic: checked.topic,
            visibility: 'personal',
          },
          operation: 'create',
          onCanonicalWriteStarted: () => {
            canonicalWriteStarted = true;
          },
        }).pipe(
          Effect.onError(() =>
            canonicalWriteStarted ? Effect.void : discardSourceEvidence(location, citation).pipe(Effect.ignore),
          ),
        );
        if (result.isError === true && !canonicalWriteStarted) yield* discardSourceEvidence(location, citation);
        if (result.isError === true) return result;
        return {
          ...result,
          content: [
            ...result.content,
            {type: 'text' as const, text: `SOURCE EVIDENCE CITATION\n${serializeSourceEvidenceCitation(citation)}`},
          ],
          structuredContent: {...result.structuredContent, sourceEvidence: citation},
        };
      }).pipe(
        Effect.catch(error => Effect.succeed(mcpErrorResult(error))),
        Effect.flatMap(withStaleVersionNotice),
      );
    },
  );
}
