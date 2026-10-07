import {Ellipsis} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

export interface MenuAction {
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

export function ActionMenu({
  label,
  actions,
  disabled,
}: {
  readonly label: string;
  readonly actions: readonly MenuAction[];
  readonly disabled?: boolean;
}): React.ReactElement {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{top: number; left: number}>();
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setPosition(undefined);
    };
    const scroll = () => setPosition(undefined);
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', scroll);
    };
  }, [position]);
  return (
    <>
      <button
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!position}
        className="item-menu-trigger"
        disabled={disabled}
        ref={trigger}
        type="button"
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition(
            position
              ? undefined
              : {
                  top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - actions.length * 38 - 16)),
                  left: Math.max(8, Math.min(rect.right - 210, window.innerWidth - 218)),
                },
          );
        }}
      >
        <Ellipsis aria-hidden="true" />
      </button>
      {position && !disabled
        ? createPortal(
            <div
              className="action-menu"
              ref={menu}
              role="menu"
              aria-label={label}
              style={position}
              onKeyDown={event => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                  setPosition(undefined);
                  if (event.key === 'Escape') trigger.current?.focus();
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
                }
              }}
            >
              {actions.map(action => (
                <button
                  className={action.danger ? 'danger-text' : undefined}
                  disabled={action.disabled}
                  key={action.label}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setPosition(undefined);
                    trigger.current?.focus();
                    action.onSelect();
                  }}
                >
                  {action.icon}
                  {action.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
