import {Array as EffectArray} from 'effect';
import {Option} from 'effect';

export type JsonObject = {[key: string]: unknown};

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

const parseJson = Option.liftThrowable((content: string): unknown => JSON.parse(content));

export function parseJsonConfigObject(content: string): JsonObject | undefined {
  const parsed = Option.getOrUndefined(parseJson(content));
  return isJsonObject(parsed) ? parsed : undefined;
}
