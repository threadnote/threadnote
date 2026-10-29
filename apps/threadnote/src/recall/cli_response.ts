import {Array as EffectArray} from 'effect';
import type {RecallOptions} from '../types.js';
import type {RecallConfidence} from '@threadnote/recall/rank';
import {
  EXPLICIT_MEMORY_CONNECTION_CONFIDENCE_BASIS,
  actionableMemoryConnectionUris,
  explicitMemoryConnectionNavigationConfidence,
} from '@threadnote/recall/connection_confidence';
import {
  parseRecallMemoryConnectionInput,
  type ParsedRecallMemoryConnectionInput,
  type RecallMemoryConnectionsResult,
} from '@threadnote/recall/memory/connections';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const RECALL_FEEDBACK_CLI_GUIDANCE =
  'Feedback: threadnote recall-feedback <threadnote://uri> --query <original-query> --action useful|wrong|pin|dismiss|applied (pin also requires --project).';

export interface ParsedRecallCliInput {
  readonly memoryConnections: ParsedRecallMemoryConnectionInput | undefined;
  readonly query: string;
}

export interface RecallCliProjection {
  readonly confidence: RecallConfidence | undefined;
  readonly rankedContext: string;
  readonly sections: readonly string[];
}

export function parseRecallCliInput(
  options: Pick<RecallOptions, 'memoryRefs' | 'query' | 'relationTypes'>,
): ParsedRecallCliInput {
  const memoryConnections = parseRecallCliMemoryConnectionInput(options);
  const query =
    Effect.pipe(options.query, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ) ?? '';
  if (query.length === 0 && memoryConnections === undefined) {
    throw new Error(
      EffectArray.join(
        [
          'Threadnote recall needs either a non-empty --query or at least one --memory-ref seed.',
          'Examples: threadnote recall --query "latest handoff" or threadnote recall --memory-ref tn_example.',
        ],
        '\n',
      ),
    );
  }
  return {memoryConnections, query};
}

export function parseRecallCliMemoryConnectionInput(
  options: Pick<RecallOptions, 'memoryRefs' | 'relationTypes'>,
): ParsedRecallMemoryConnectionInput | undefined {
  if ((options.relationTypes?.length ?? 0) > 0 && (options.memoryRefs?.length ?? 0) === 0) {
    throw new Error('--relation-type requires at least one --memory-ref.');
  }
  return (options.memoryRefs?.length ?? 0) > 0
    ? parseRecallMemoryConnectionInput({
        memoryRefs: options.memoryRefs ?? [],
        relationTypes: options.relationTypes,
      })
    : undefined;
}

export function renderRecallMemoryConnections(result: RecallMemoryConnectionsResult): string {
  const premiseLines = EffectArray.map(
    result.premises,
    premise => `- premise ${premise.requestedOrdinal + 1}: ${premise.uri ?? premise.requestedRef} [${premise.state}]`,
  );
  const connectionLines = EffectArray.map(result.connections, connection => {
    const pointer = connection.neighborUri ?? 'unresolved target';
    return `- ${connection.direction} ${connection.relationType}: ${pointer} [${connection.currentness}; ${connection.resolution}]`;
  });
  return EffectArray.join(
    [
      `Memory connections (one hop; ${result.coverage.resultCount} result(s)${result.coverage.truncated ? ', truncated' : ''}):`,
      ...premiseLines,
      ...connectionLines,
      'Relations are navigation evidence, not entailment.',
    ],
    '\n',
  );
}

export function explicitMemoryConnectionConfidence(
  result: RecallMemoryConnectionsResult | undefined,
): RecallConfidence | undefined {
  return actionableMemoryConnectionUris(result).length > 0 ? explicitMemoryConnectionNavigationConfidence() : undefined;
}

export function renderSeedOnlyRecallNavigation(result: RecallMemoryConnectionsResult): string {
  const firstNeighbor = actionableMemoryConnectionUris(result)[0];
  const confidence = explicitMemoryConnectionNavigationConfidence();
  return EffectArray.join(
    [
      ...(firstNeighbor
        ? [
            `Recall confidence: ${confidence.level} (${confidence.score.toFixed(2)}; ${EXPLICIT_MEMORY_CONNECTION_CONFIDENCE_BASIS}) — ${confidence.reason}`,
          ]
        : []),
      renderRecallMemoryConnections(result),
      ...(firstNeighbor ? [`Next: threadnote read ${firstNeighbor}`] : []),
    ],
    '\n',
  );
}

export function projectRecallCliResponse(
  input: {
    readonly confidence?: RecallConfidence;
    readonly exactTail?: string;
    readonly memoryConnections?: RecallMemoryConnectionsResult;
    readonly semanticSection?: string;
  },
  navigationOnly: boolean,
): RecallCliProjection {
  const rankedContext = navigationOnly ? '' : (input.semanticSection ?? '');
  const sections = navigationOnly
    ? input.memoryConnections
      ? [renderSeedOnlyRecallNavigation(input.memoryConnections)]
      : []
    : EffectArray.filter(
        [
          input.semanticSection,
          input.exactTail,
          input.memoryConnections ? renderRecallMemoryConnections(input.memoryConnections) : undefined,
        ],
        (section): section is string => section !== undefined,
      );
  const surfacedSections = sections.length > 0 ? [...sections, RECALL_FEEDBACK_CLI_GUIDANCE] : sections;
  return {
    confidence:
      (navigationOnly ? explicitMemoryConnectionConfidence(input.memoryConnections) : undefined) ?? input.confidence,
    rankedContext,
    sections: surfacedSections,
  };
}
