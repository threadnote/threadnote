// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {clampLibraryNavigatorWidth, useLibraryNavigatorResize} from '../../src/library_layout.js';

const WIDTH_KEY = 'threadnote.manager.libraryNavigatorWidth';
let container: HTMLDivElement;
let root: Root;
let availableWidth: number;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;

function Harness({visible = true}: {visible?: boolean}) {
  const navigator = useLibraryNavigatorResize();
  return visible ? (
    <div ref={navigator.workspaceRef} style={navigator.style} data-resizing={navigator.resizing}>
      <aside id="library-navigator" />
      {navigator.resizer}
    </div>
  ) : null;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  localStorage.removeItem(WIDTH_KEY);
  document.cookie = `${WIDTH_KEY}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  availableWidth = 1000;
  disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({width: availableWidth}) as DOMRect,
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem(WIDTH_KEY);
  document.cookie = `${WIDTH_KEY}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const separator = () => container.querySelector<HTMLDivElement>('[role="separator"]')!;
const width = () => Number(separator().getAttribute('aria-valuenow'));
const key = async (value: string, shiftKey = false) =>
  act(async () => separator().dispatchEvent(new KeyboardEvent('keydown', {key: value, shiftKey, bubbles: true})));

it('bounds arbitrary widths, is monotonic and idempotent, and reserves space for the reader', () => {
  fc.assert(
    fc.property(
      fc.integer({min: -2000, max: 2000}),
      fc.integer({min: -2000, max: 2000}),
      fc.integer({min: 501, max: 1600}),
      (first, second, available) => {
        const result = clampLibraryNavigatorWidth(first, available);
        expect(result).toBeGreaterThanOrEqual(180);
        expect(result).toBeLessThanOrEqual(600);
        expect(result + 321).toBeLessThanOrEqual(available);
        expect(clampLibraryNavigatorWidth(result, available)).toBe(result);
        expect(clampLibraryNavigatorWidth(Math.min(first, second), available)).toBeLessThanOrEqual(
          clampLibraryNavigatorWidth(Math.max(first, second), available),
        );
      },
    ),
    {numRuns: 60},
  );
  expect(clampLibraryNavigatorWidth(NaN)).toBe(231);
  expect(clampLibraryNavigatorWidth(Infinity)).toBe(231);
});

it('supports keyboard resizing, reset and persistence when the Library is reopened', async () => {
  await act(async () => root.render(<Harness />));
  expect(width()).toBe(231);
  await key('ArrowRight');
  expect(width()).toBe(247);
  await key('ArrowRight', true);
  expect(width()).toBe(295);
  await key('ArrowLeft');
  expect(width()).toBe(279);
  expect(localStorage.getItem(WIDTH_KEY)).toBe('279');
  expect(document.cookie).toContain(`${WIDTH_KEY}=279`);
  await act(async () => root.render(<Harness visible={false} />));
  await act(async () => root.render(<Harness />));
  expect(width()).toBe(279);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(width()).toBe(279);
  await key('Home');
  expect(width()).toBe(180);
  await key('ArrowLeft');
  expect(width()).toBe(180);
  await key('End');
  expect(width()).toBe(600);
  await key('ArrowRight');
  expect(width()).toBe(600);
  await key('Enter');
  expect(width()).toBe(231);
});

it('measures the navigator when Library opens and restores the preferred width after a narrow viewport', async () => {
  localStorage.setItem(WIDTH_KEY, '500');
  await act(async () => root.render(<Harness visible={false} />));
  availableWidth = 750;
  await act(async () => root.render(<Harness />));
  expect(width()).toBe(429);
  expect(separator().getAttribute('aria-valuemax')).toBe('429');
  expect(localStorage.getItem(WIDTH_KEY)).toBe('500');
  availableWidth = 1000;
  await act(async () => resize());
  expect(width()).toBe(500);
  availableWidth = 750;
  await act(async () => resize());
  await key('End');
  expect(width()).toBe(429);
  expect(localStorage.getItem(WIDTH_KEY)).toBe('429');
  await act(async () => root.render(<Harness visible={false} />));
  expect(disconnect).toHaveBeenCalled();
});

it('drags only the captured pointer, saves the final width and resets on double click', async () => {
  await act(async () => root.render(<Harness />));
  expect(width()).toBe(231);
  const handle = separator();
  let captured: number | undefined;
  handle.setPointerCapture = id => {
    captured = id;
  };
  handle.hasPointerCapture = id => captured === id;
  handle.releasePointerCapture = () => {
    captured = undefined;
  };
  const pointer = async (type: string, clientX: number, pointerId = 1) =>
    act(async () => handle.dispatchEvent(new PointerEvent(type, {clientX, pointerId, button: 0, bubbles: true})));
  await pointer('pointerdown', 240);
  expect(captured).toBe(1);
  await pointer('pointermove', 440, 2);
  expect(width()).toBe(231);
  await pointer('pointermove', 440);
  expect(width()).toBe(431);
  expect(localStorage.getItem(WIDTH_KEY)).toBe('431');
  expect(container.firstElementChild?.getAttribute('data-resizing')).toBe('true');
  await pointer('pointerup', 440);
  expect(captured).toBeUndefined();
  expect(localStorage.getItem(WIDTH_KEY)).toBe('431');
  expect(container.firstElementChild?.getAttribute('data-resizing')).toBe('false');
  await pointer('pointermove', 500);
  expect(width()).toBe(431);
  await pointer('pointerdown', 440);
  await pointer('pointermove', -1000);
  expect(width()).toBe(180);
  await pointer('pointercancel', -1000);
  expect(localStorage.getItem(WIDTH_KEY)).toBe('180');
  expect(container.firstElementChild?.getAttribute('data-resizing')).toBe('false');
  await act(async () => handle.dispatchEvent(new MouseEvent('dblclick', {bubbles: true})));
  expect(width()).toBe(231);
  expect(localStorage.getItem(WIDTH_KEY)).toBe('231');
});
