import React, {useEffect, useRef, useState} from 'react';
import {readManagerPreference, writeManagerPreference} from './preferences.js';

const WIDTH_KEY = 'threadnote.manager.libraryNavigatorWidth';
const DEFAULT_WIDTH = 231;
const MIN_WIDTH = 180;
const MAX_WIDTH = 600;
const READER_SPACE = 321;

function maximumWidth(availableWidth: number): number {
  return Math.floor(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availableWidth - READER_SPACE)));
}

export function clampLibraryNavigatorWidth(width: number, availableWidth = Infinity): number {
  return Math.min(
    maximumWidth(availableWidth),
    Math.max(MIN_WIDTH, Math.round(Number.isFinite(width) ? width : DEFAULT_WIDTH)),
  );
}

export function useLibraryNavigatorResize() {
  const [workspace, setWorkspace] = useState<HTMLDivElement | null>(null);
  const drag = useRef<{pointerId: number; startX: number; width: number} | undefined>(undefined);
  const [preferredWidth, setPreferredWidth] = useState(() =>
    clampLibraryNavigatorWidth(Number(readManagerPreference(WIDTH_KEY) ?? DEFAULT_WIDTH)),
  );
  const latestWidth = useRef(preferredWidth);
  const [availableWidth, setAvailableWidth] = useState(Infinity);
  const [resizing, setResizing] = useState(false);
  const width = clampLibraryNavigatorWidth(preferredWidth, availableWidth);
  const maximum = maximumWidth(availableWidth);

  useEffect(() => {
    if (!workspace) {
      drag.current = undefined;
      setResizing(false);
      return;
    }
    const measure = () => {
      const size = workspace.getBoundingClientRect().width;
      if (size > 0) setAvailableWidth(size);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [workspace]);

  function update(next: number, persist = true) {
    const measured = workspace?.getBoundingClientRect().width;
    const bounded = clampLibraryNavigatorWidth(next, measured && measured > 0 ? measured : availableWidth);
    latestWidth.current = bounded;
    setPreferredWidth(bounded);
    if (persist) writeManagerPreference(WIDTH_KEY, String(bounded));
  }

  function stop(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    setResizing(false);
    writeManagerPreference(WIDTH_KEY, String(latestWidth.current));
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const resizer = (
    <div
      role="separator"
      aria-label="Resize Library navigator"
      aria-controls="library-navigator"
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maximum}
      aria-valuenow={width}
      tabIndex={0}
      className="library-navigator-resizer"
      title="Drag to resize navigator. Arrow keys adjust width; Enter resets."
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {pointerId: event.pointerId, startX: event.clientX, width};
        latestWidth.current = width;
        setResizing(true);
      }}
      onPointerMove={event => {
        if (drag.current?.pointerId === event.pointerId)
          update(drag.current.width + event.clientX - drag.current.startX, false);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => update(DEFAULT_WIDTH)}
      onKeyDown={event => {
        const step = event.shiftKey ? 48 : 16;
        const widths: Record<string, number> = {
          ArrowLeft: width - step,
          ArrowRight: width + step,
          Home: MIN_WIDTH,
          End: maximum,
          Enter: DEFAULT_WIDTH,
        };
        const next = widths[event.key];
        if (next === undefined) return;
        event.preventDefault();
        update(next);
      }}
    />
  );
  const style: React.CSSProperties & {'--library-navigator-width': string} = {
    '--library-navigator-width': `${width}px`,
  };
  return {workspaceRef: setWorkspace, style, resizing, resizer};
}
