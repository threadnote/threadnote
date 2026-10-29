import {Array as EffectArray, Option as EffectOption} from 'effect';
import {nativeCycleTextPage} from '@threadnote/workflow-automations/cycle-output';
import type {NativeWatchWork} from '@threadnote/workflow-automations/watch';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';

export const nativeWatchOutputLimit = 8192;
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const fail = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-watch-page', message});
};

export function assertNativeWatchOutput<A>(value: A): A {
  if (byteLength(value) > nativeWatchOutputLimit) return fail('Watch response exceeds its byte budget.');
  return value;
}

/** Large records retain a complete digest-bound detail reader instead of becoming unreadable. */
export function nativeWatchWorkList(work: readonly NativeWatchWork[], offset = 0) {
  const items: unknown[] = [];
  for (const item of work.slice(offset, offset + 32)) {
    const content = stableJson(item);
    const detail = {command: 'work-detail', eventId: item.eventId, sourceDigest: sha256HexSync(content)};
    const value =
      byteLength(item) <= 5000
        ? item
        : {
            eventId: item.eventId,
            status: item.status,
            at: item.at,
            event: item.event,
            available: false,
            reason: 'detail-required',
            detail,
          };
    if (byteLength([...items, value]) > 6000) {
      if (items.length) break;
      items.push({eventId: item.eventId, status: item.status, at: item.at, available: false, detail});
      break;
    }
    items.push(value);
  }
  return {items, offset, nextOffset: offset + items.length < work.length ? offset + items.length : null};
}

export function nativeWatchWorkDetail(
  work: readonly NativeWatchWork[],
  eventId: string,
  offsetBytes = 0,
  sourceDigest?: string,
) {
  const item = EffectOption.getOrUndefined(EffectArray.findFirst(work, value => value.eventId === eventId));
  if (!item) return fail('Watch work record is unavailable.');
  try {
    return {eventId, ...nativeCycleTextPage(stableJson(item), {maxBytes: 3000, offsetBytes, sourceDigest})};
  } catch {
    return fail('Watch work changed or its UTF-8 cursor is invalid; reload the record.');
  }
}
