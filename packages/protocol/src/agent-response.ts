import {Schema} from 'effect';
export const AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN = 3 as const;

export interface AgentToolResponseMeasurement {
  readonly estimatedTokens: number;
  readonly structuredBytes: number;
  readonly textBytes: number;
  readonly totalBytes: number;
}

export interface RankedJsonPrefixProjection<T> {
  readonly encodedBytes: number;
  readonly estimatedTokens: number;
  readonly omittedItems: number;
  readonly returnedItems: number;
  readonly truncated: boolean;
  readonly value: T;
}

export class AgentResponseBudgetTooSmallError extends Schema.TaggedError<
  AgentResponseBudgetTooSmallError,
  {readonly brand: unique symbol}
>()('AgentResponseBudgetTooSmallError', {
  maximumBytes: Schema.Finite,
  message: Schema.String,
  minimumBytes: Schema.Finite,
}) {
  static of(maximumBytes: number, minimumBytes: number): AgentResponseBudgetTooSmallError {
    return AgentResponseBudgetTooSmallError.make({
      maximumBytes,
      message: `Agent response budget ${maximumBytes} bytes cannot fit the required ${minimumBytes}-byte envelope.`,
      minimumBytes,
    });
  }
}

export function encodedJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Agent response must be JSON serializable.');
  return encodedTextBytes(serialized);
}

export function encodedTextBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function estimatedAgentTokens(
  encodedBytes: number,
  bytesPerToken = AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
): number {
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes < 0) {
    throw new Error('Agent response bytes must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(bytesPerToken) || bytesPerToken < 1) {
    throw new Error('Agent response bytes per token must be a positive safe integer.');
  }
  return Math.ceil(encodedBytes / bytesPerToken);
}

/**
 * Measures the bytes an MCP client receives. Structured content and text are
 * counted independently because returning the same evidence in both fields
 * still consumes context twice.
 */
export function measureAgentToolResponse(response: {
  readonly structuredContent?: unknown;
  readonly text?: string;
}): AgentToolResponseMeasurement {
  const structuredBytes = response.structuredContent === undefined ? 0 : encodedJsonBytes(response.structuredContent);
  const textBytes = response.text === undefined ? 0 : encodedTextBytes(response.text);
  const totalBytes = structuredBytes + textBytes;
  return {
    estimatedTokens: estimatedAgentTokens(totalBytes),
    structuredBytes,
    textBytes,
    totalBytes,
  };
}

/**
 * Selects the longest ranked prefix whose canonical JSON projection fits a
 * hard byte envelope. `render` must retain required trust/coverage metadata
 * even for an empty prefix. The returned value is measured exactly; card
 * count is never used as a proxy for bytes or tokens.
 */
export function projectRankedJsonPrefix<TItem, TValue>(
  items: readonly TItem[],
  maximumBytes: number,
  render: (prefix: readonly TItem[], omittedItems: number) => TValue,
): RankedJsonPrefixProjection<TValue> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('Agent response maximum bytes must be a positive safe integer.');
  }
  const empty = render([], items.length);
  const minimumBytes = encodedJsonBytes(empty);
  if (minimumBytes > maximumBytes) {
    throw AgentResponseBudgetTooSmallError.of(maximumBytes, minimumBytes);
  }

  // Do not assume the renderer's envelope size is monotonic. Omission receipts
  // can cross digit boundaries, and future projections may conditionally drop
  // metadata as cards are retained. Evaluation sizes are deliberately bounded,
  // so measuring every prefix gives the exact longest prefix without smuggling
  // a monotonicity requirement into the public helper.
  let selectedCount = 0;
  let selectedValue = empty;
  let selectedBytes = minimumBytes;
  for (let candidateCount = 1; candidateCount <= items.length; candidateCount += 1) {
    const candidate = render(items.slice(0, candidateCount), items.length - candidateCount);
    const candidateBytes = encodedJsonBytes(candidate);
    if (candidateBytes <= maximumBytes) {
      selectedCount = candidateCount;
      selectedValue = candidate;
      selectedBytes = candidateBytes;
    }
  }

  return {
    encodedBytes: selectedBytes,
    estimatedTokens: estimatedAgentTokens(selectedBytes),
    omittedItems: items.length - selectedCount,
    returnedItems: selectedCount,
    truncated: selectedCount < items.length,
    value: selectedValue,
  };
}
