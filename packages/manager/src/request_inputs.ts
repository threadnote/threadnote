import {Option} from 'effect';
import {ManagerRequestInputError, requireString} from '@threadnote/integration-core/manager-inputs';
export {
  requireString,
  optionalString,
  requireStringArray,
  requireConfirm,
} from '@threadnote/integration-core/manager-inputs';
import type {ConsolidationAgent} from '@threadnote/integrations/agents';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';

export function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw ManagerRequestInputError.make({message: `Missing query parameter: ${name}`});
  return value;
}

export function optionalPositiveIntegerQuery(url: URL, name: string): Option.Option<number> {
  return Option.fromNullishOr(url.searchParams.get(name)).pipe(
    Option.map(value => Number(value)),
    Option.filter(value => Number.isSafeInteger(value) && value > 0),
  );
}

export function optionalNonNegativeIntegerQuery(url: URL, name: string): Option.Option<number> {
  return Option.fromNullishOr(url.searchParams.get(name)).pipe(
    Option.map(value => Number(value)),
    Option.filter(value => Number.isSafeInteger(value) && value >= 0),
  );
}

export function optionalNonEmptyQuery(url: URL, name: string): Option.Option<string> {
  return Option.fromNullishOr(url.searchParams.get(name)).pipe(
    Option.map(value => value.trim()),
    Option.filter(value => value.length > 0),
  );
}

export function optionalGraphScopeIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const identity = requireString(value, 'scopeId');
  if (!/^code-graph-scope:[0-9a-f]{64}$/.test(identity)) {
    throw ManagerRequestInputError.make({message: 'Provide scopeId as an exact graph scope identity.'});
  }
  return identity;
}

export function memoryKind(value: unknown): MemoryKind | undefined {
  return value === 'durable' ||
    value === 'handoff' ||
    value === 'incident' ||
    value === 'preference' ||
    value === 'smoke'
    ? value
    : undefined;
}

export function memoryStatus(value: unknown): MemoryStatus | undefined {
  return value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded'
    ? value
    : undefined;
}

export function consolidationAgent(value: string): ConsolidationAgent {
  if (
    value === 'codex' ||
    value === 'claude' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'effect-ai' ||
    value === 'local-ai'
  ) {
    return value;
  }
  throw ManagerRequestInputError.make({message: `Unsupported consolidation agent: ${value}`});
}

export function cleanupMode(value: unknown): 'archive' | 'forget' | 'keep' {
  return value === 'forget' || value === 'keep' ? value : 'archive';
}
