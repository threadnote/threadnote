// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ValuePanel} from '@threadnote/manager/value_view';
import {aggregateValueReportV1} from '@threadnote/threadnote/value_report/index';
import {isJsonObject} from '@threadnote/platform/json';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

let reactRoot: Root | undefined;
let requests: Array<{readonly body: Record<string, unknown>; readonly path: string}>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const parsedBody: unknown = init?.body ? JSON.parse(String(init.body)) : {};
    if (!isJsonObject(parsedBody)) throw new Error('Expected a value request object.');
    const body = parsedBody;
    requests.push({body, path});
    if (path === '/api/value/report') {
      return Promise.resolve(
        jsonResponse(
          aggregateValueReportV1({
            feedbackEvents: [
              {
                action: 'applied',
                project: 'threadnote',
                queryFingerprint: Effect.pipe('a', EffectString.repeat(64)),
                rankerVersion: 'hybrid-v1',
                timestamp: '2026-09-15T00:00:00.000Z',
                uri: 'threadnote://private/value',
                version: 1,
              },
            ],
            period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
            project: String(body.project ?? ''),
          }),
        ),
      );
    }
    if (path === '/api/value/retention') {
      return Promise.resolve(
        jsonResponse({
          applied: body.apply,
          feedback: {after: 1, applied: body.apply, before: 2, removed: 1},
          retentionDays: body.days,
          type: 'value-report-retention',
          valueEvents: {after: 3, applied: body.apply, before: 5, removed: 2},
          version: 1,
        }),
      );
    }
    if (path === '/api/value/delete') {
      return Promise.resolve(
        jsonResponse({
          applied: body.apply,
          exports: {removed: body.exports ? 1 : 0, selected: body.exports},
          feedback: {after: 0, applied: body.apply, before: 1, removed: 1, selected: body.feedback},
          type: 'value-report-deletion',
          valueEvents: {after: 0, applied: body.apply, before: 2, removed: 2, selected: body.events},
          version: 1,
        }),
      );
    }
    throw new Error(`Unexpected Manager value request: ${path}`);
  });
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Manager value workspace', () => {
  it('shows applied outcomes and keeps retention and deletion preview-first', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () => reactRoot?.render(React.createElement(ValuePanel, {project: 'threadnote'})));

    await clickButton('Load value report');
    await waitForText('1 applied');
    expect(document.body.textContent).toContain('Local and content-free');
    expect(document.body.textContent).toContain('second-agent reuse');
    expect(requests[0]).toEqual({body: {period: 30, project: 'threadnote'}, path: '/api/value/report'});

    await clickButton('Preview retention');
    await waitForText('Preview: remove 1 feedback and 2 value event(s); keep 365 days.');
    expect(requests.at(-1)).toEqual({body: {apply: false, days: 365}, path: '/api/value/retention'});

    await clickButton('Preview deletion');
    await waitForText('Preview: 1 feedback, 2 value event(s), 0 export bundle(s).');
    expect(requests.at(-1)).toEqual({
      body: {apply: false, events: true, exports: false, feedback: true},
      path: '/api/value/delete',
    });
  });
});

async function clickButton(label: string): Promise<void> {
  const button = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      candidate =>
        Effect.pipe(candidate.textContent, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
        ) === label,
    ),
  );
  if (!button) throw new Error(`Button did not render: ${label}`);
  await act(async () => button.click());
}

async function waitForText(text: string): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (
      Effect.pipe(document.body.textContent, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.includes(text)),
      )
    )
      return;
    await act(async () => {
      await Promise.resolve();
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });
  }
  throw new Error(`Text did not render: ${text}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}, status});
}
