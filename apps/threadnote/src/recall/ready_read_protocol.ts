import {isJsonObject} from '@threadnote/platform/json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {recallReadyReadRequestSchema, type RecallReadyReadRequest} from '@threadnote/recall/read_boundary';
import {Record as EffectRecord, Schema} from 'effect';

export const RECALL_READY_READ_INPUT_BYTES = 256 * 1024;
export const RECALL_READY_READ_OUTPUT_BYTES = 16 * 1024 * 1024;

export function recallReadyReadBinding(request: RecallReadyReadRequest): string {
  return sha256HexSync(
    JSON.stringify(Schema.encodeSync(recallReadyReadRequestSchema)(request), (_key, value: unknown) =>
      isJsonObject(value)
        ? EffectRecord.fromEntries(
            EffectRecord.toEntries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
          )
        : value,
    ),
  );
}
