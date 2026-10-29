import {Array as EffectArray, Option as EffectOption} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {RuntimeHealthPanel, runtimeHealthGroups, type RuntimeCheck} from '../../src/runtime_health_view.js';

it('preserves every diagnostic exactly once and never reports success over a failing check', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          name: fc.constantFrom('runtime binary', 'storage index', 'agent integration', 'workspace'),
          detail: fc.string({maxLength: 40}),
          status: fc.constantFrom('ok' as const, 'warn' as const, 'fail' as const),
        }),
        {maxLength: 60},
      ),
      checks => {
        const before = structuredClone(checks);
        const groups = runtimeHealthGroups(checks);
        expect(EffectArray.flatMap(groups, group => group.checks)).toHaveLength(checks.length);
        for (const check of checks)
          expect(
            EffectArray.filter(
              EffectArray.flatMap(groups, group => group.checks),
              item => item === check,
            ),
          ).toHaveLength(1);
        const severity = {ok: 0, warn: 1, fail: 2};
        for (const group of groups)
          expect(severity[group.status]).toBe(
            Math.max(...EffectArray.map(group.checks, check => severity[check.status])),
          );
        expect(checks).toEqual(before);
        expect(EffectArray.map(runtimeHealthGroups(checks), group => group.label)).toEqual(
          EffectArray.map(groups, group => group.label),
        );
      },
    ),
    {numRuns: 60},
  );
});

it('enables repair only after a successful preview and exposes actual diagnostic details', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const preview = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const repair = vi.fn();
  const checks: readonly RuntimeCheck[] = [{name: 'storage index', detail: 'Synthetic missing index', status: 'fail'}];
  try {
    await act(async () =>
      root.render(
        <RuntimeHealthPanel
          checks={checks}
          output=""
          onPreviewRepair={preview}
          onRepair={repair}
          onRefresh={() => {}}
          onVerify={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('Failed');
    expect(container.querySelector('.runtime-check-details')?.textContent).toContain('Synthetic missing index');
    const button = (text: string) =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst([...container.querySelectorAll('button')], item => item.textContent === text),
      )!;
    await act(async () => button('Repair').click());
    await act(async () => button('Preview repair').click());
    expect(button('Apply repair…').disabled).toBe(true);
    await act(async () => button('Preview repair').click());
    expect(button('Apply repair…').disabled).toBe(false);
    await act(async () => button('Apply repair…').click());
    expect(repair).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
