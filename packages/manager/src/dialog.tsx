import {Array as EffectArray} from 'effect';
import React, {createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState} from 'react';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type ManagerDialogTone = 'default' | 'danger';

export interface ManagerDialogField {
  readonly allowCreate?: boolean;
  readonly description?: string;
  readonly id: string;
  readonly initialValue?: string;
  readonly label: string;
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly required?: boolean;
}

export interface ManagerDialogOptions {
  readonly cancelLabel?: string;
  readonly confirmLabel?: string;
  readonly detail?: string;
  readonly fields?: readonly ManagerDialogField[];
  readonly message?: string;
  readonly title: string;
  readonly tone?: ManagerDialogTone;
}

export type ManagerDialogValues = Readonly<Record<string, string>>;

export type ManagerDialogValidation =
  {readonly fieldId: string; readonly ok: false} | {readonly ok: true; readonly values: ManagerDialogValues};

export interface ManagerDialogs {
  readonly confirm: (options: ManagerDialogOptions) => Promise<boolean>;
  readonly prompt: (options: ManagerDialogOptions) => Promise<ManagerDialogValues | undefined>;
}

interface PendingDialog {
  readonly options: ManagerDialogOptions;
  readonly resolve: (result: ManagerDialogValues | undefined) => void;
}

export interface ManagerAutocompleteEntry {
  readonly kind: 'create' | 'existing';
  readonly label: string;
  readonly value: string;
}

interface PreparedManagerAutocompleteOption {
  readonly normalized: string;
  readonly value: string;
}

export interface ManagerAutocompleteInputProps {
  readonly allowCreate?: boolean;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly initialFocus?: boolean;
  readonly invalid?: boolean;
  readonly name?: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly string[];
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly value: string;
}

const ManagerDialogContext = createContext<ManagerDialogs | undefined>(undefined);
const INERT_MANAGER_DIALOGS: ManagerDialogs = {
  confirm: () => Promise.resolve(false),
  prompt: () => Promise.resolve(undefined),
};

export function managerAutocompleteEntries(
  options: readonly string[],
  query: string,
  allowCreate: boolean,
): readonly ManagerAutocompleteEntry[] {
  return managerAutocompleteEntriesFromPrepared(prepareManagerAutocompleteOptions(options), query, allowCreate);
}

function prepareManagerAutocompleteOptions(options: readonly string[]): readonly PreparedManagerAutocompleteOption[] {
  const unique = new Map<string, string>();
  for (const option of options) {
    const trimmed = Effect.pipe(option, EffectString.trim);
    if (!trimmed) continue;
    const normalized = Effect.pipe(trimmed, EffectString.toLocaleLowerCase());
    if (!unique.has(normalized)) unique.set(normalized, trimmed);
  }
  return EffectArray.map([...unique.entries()], ([normalized, value]) => ({normalized, value})).sort((left, right) =>
    Effect.pipe(left.value, EffectString.localeCompare(right.value)),
  );
}

function managerAutocompleteEntriesFromPrepared(
  options: readonly PreparedManagerAutocompleteOption[],
  query: string,
  allowCreate: boolean,
): readonly ManagerAutocompleteEntry[] {
  const trimmedQuery = Effect.pipe(query, EffectString.trim);
  const normalizedQuery = Effect.pipe(trimmedQuery, EffectString.toLocaleLowerCase());
  const existing = EffectArray.map(
    EffectArray.filter(
      options,
      (option, __effectArrayIndex) =>
        __effectArrayIndex in options && Effect.pipe(option.normalized, EffectString.includes(normalizedQuery)),
    ),
    ({value}): ManagerAutocompleteEntry => ({kind: 'existing', label: value, value}),
  );
  if (!allowCreate || !trimmedQuery || EffectArray.some(options, option => option.normalized === normalizedQuery))
    return existing;
  return [{kind: 'create', label: `Create “${trimmedQuery}”`, value: trimmedQuery}, ...existing];
}

export function ManagerAutocompleteInput(props: ManagerAutocompleteInputProps): React.ReactElement {
  const listboxId = `${useId()}-options`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const preparedOptions = useMemo(() => prepareManagerAutocompleteOptions(props.options), [props.options]);
  const entries = useMemo(
    () => managerAutocompleteEntriesFromPrepared(preparedOptions, props.value, props.allowCreate === true),
    [preparedOptions, props.allowCreate, props.value],
  );
  const activeEntry = entries[activeIndex];

  useEffect(() => {
    setActiveIndex(current => Math.min(current, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  const choose = (entry: ManagerAutocompleteEntry): void => {
    props.onChange(entry.value);
    setOpen(false);
  };

  return (
    <div
      className="manager-autocomplete"
      onBlur={event => {
        const relatedTarget = event.relatedTarget;
        if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) setOpen(false);
      }}
    >
      <input
        aria-activedescendant={open && activeEntry ? `${listboxId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open && entries.length > 0}
        aria-haspopup="listbox"
        aria-invalid={props.invalid}
        aria-required={props.required}
        autoComplete="off"
        data-manager-dialog-initial-focus={props.initialFocus}
        disabled={props.disabled}
        id={props.id}
        name={props.name}
        onChange={event => {
          props.onChange(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onClick={() => {
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entries.length > 0) {
            event.preventDefault();
            setOpen(true);
            setActiveIndex(current =>
              event.key === 'ArrowDown'
                ? (current + 1) % entries.length
                : (current - 1 + entries.length) % entries.length,
            );
            return;
          }
          if (event.key === 'Enter' && open && activeEntry) {
            event.preventDefault();
            choose(activeEntry);
          }
        }}
        placeholder={props.placeholder}
        required={props.required}
        role="combobox"
        value={props.value}
      />
      {open && entries.length > 0 ? (
        <div className="manager-autocomplete-menu" id={listboxId} role="listbox">
          {EffectArray.map(entries, (entry, index) => (
            <button
              aria-selected={index === activeIndex}
              className={`${entry.kind === 'create' ? 'is-create' : ''} ${index === activeIndex ? 'is-active' : ''}`}
              id={`${listboxId}-${index}`}
              key={`${entry.kind}:${entry.value}`}
              onClick={() => choose(entry)}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              type="button"
            >
              {entry.kind === 'create' ? <span aria-hidden="true">+</span> : null}
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function validateManagerDialogValues(
  fields: readonly ManagerDialogField[],
  input: Readonly<Record<string, string>>,
): ManagerDialogValidation {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = Effect.pipe(input[field.id] ?? '', EffectString.trim);
    if (field.required && value.length === 0) {
      return {fieldId: field.id, ok: false};
    }
    values[field.id] = value;
  }
  return {ok: true, values};
}

export function ManagerDialogProvider(props: {readonly children: React.ReactNode}): React.ReactElement {
  const [pending, setPending] = useState<PendingDialog | undefined>();
  const pendingRef = useRef<PendingDialog | undefined>(undefined);
  const queueRef = useRef<PendingDialog[]>([]);

  const present = useCallback((next: PendingDialog): void => {
    if (pendingRef.current) {
      queueRef.current.push(next);
      return;
    }
    pendingRef.current = next;
    setPending(next);
  }, []);

  const finish = useCallback((result: ManagerDialogValues | undefined): void => {
    const current = pendingRef.current;
    if (!current) return;
    current.resolve(result);
    const next = queueRef.current.shift();
    pendingRef.current = next;
    setPending(next);
  }, []);

  const prompt = useCallback(
    (options: ManagerDialogOptions): Promise<ManagerDialogValues | undefined> => {
      const {promise, resolve} = Promise.withResolvers<ManagerDialogValues | undefined>();
      present({options, resolve});
      return promise;
    },
    [present],
  );

  const confirm = useCallback(
    async (options: ManagerDialogOptions): Promise<boolean> =>
      (await prompt({...options, fields: options.fields ?? []})) !== undefined,
    [prompt],
  );

  useEffect(
    () => () => {
      pendingRef.current?.resolve(undefined);
      for (const queued of queueRef.current.splice(0)) queued.resolve(undefined);
    },
    [],
  );

  const dialogs = useMemo(() => ({confirm, prompt}), [confirm, prompt]);
  return (
    <ManagerDialogContext.Provider value={dialogs}>
      {props.children}
      {pending ? <ManagerDialog onFinish={finish} request={pending} /> : null}
    </ManagerDialogContext.Provider>
  );
}

export function useManagerDialogs(): ManagerDialogs {
  const dialogs = useContext(ManagerDialogContext);
  if (!dialogs) throw new Error('Manager dialogs must be used inside ManagerDialogProvider.');
  return dialogs;
}

export function useOptionalManagerDialogs(): ManagerDialogs {
  return useContext(ManagerDialogContext) ?? INERT_MANAGER_DIALOGS;
}

function ManagerDialog(props: {
  readonly onFinish: (result: ManagerDialogValues | undefined) => void;
  readonly request: PendingDialog;
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [validationField, setValidationField] = useState<string | undefined>();
  const {options} = props.request;
  const fields = options.fields ?? [];
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => initialDialogValues(fields));
  const tone = options.tone ?? 'default';
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const descriptionId = options.message ? `${dialogId}-description` : undefined;

  useEffect(() => {
    setValidationField(undefined);
    setFieldValues(initialDialogValues(fields));
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-manager-dialog-initial-focus="true"]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [props.request]);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = validateManagerDialogValues(fields, fieldValues);
    if (!result.ok) {
      setValidationField(result.fieldId);
      const invalidField = form.elements.namedItem(result.fieldId);
      if (invalidField instanceof HTMLElement) invalidField.focus();
      return;
    }
    props.onFinish(result.values);
  };

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="manager-dialog"
      onCancel={event => {
        event.preventDefault();
        props.onFinish(undefined);
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        props.onFinish(undefined);
      }}
      ref={dialogRef}
    >
      <form className={`manager-dialog-card is-${tone}`} noValidate onSubmit={submit}>
        <header className="manager-dialog-header">
          <span aria-hidden="true" className="manager-dialog-mark">
            {tone === 'danger' ? '!' : '◇'}
          </span>
          <div>
            <p>
              {tone === 'danger'
                ? 'Confirm destructive action'
                : fields.length > 0
                  ? 'Review details'
                  : 'Confirm action'}
            </p>
            <h2 id={titleId}>{options.title}</h2>
          </div>
        </header>
        <div className="manager-dialog-body">
          {options.message ? <p id={descriptionId}>{options.message}</p> : null}
          {options.detail ? <code className="manager-dialog-detail">{options.detail}</code> : null}
          {fields.length > 0 ? (
            <div className="manager-dialog-fields">
              {EffectArray.map(fields, (field, index) => {
                const inputId = `${dialogId}-${field.id}`;
                return (
                  <div className="manager-dialog-field" key={field.id}>
                    <label htmlFor={inputId}>
                      {field.label}
                      {field.required ? <em>Required</em> : null}
                    </label>
                    {field.options ? (
                      <ManagerAutocompleteInput
                        allowCreate={field.allowCreate}
                        id={inputId}
                        initialFocus={index === 0}
                        invalid={validationField === field.id}
                        name={field.id}
                        onChange={value => {
                          setFieldValues(current => ({...current, [field.id]: value}));
                          if (validationField === field.id) setValidationField(undefined);
                        }}
                        options={field.options}
                        placeholder={field.placeholder}
                        required={field.required}
                        value={fieldValues[field.id] ?? ''}
                      />
                    ) : (
                      <input
                        aria-invalid={validationField === field.id}
                        aria-required={field.required}
                        data-manager-dialog-initial-focus={index === 0}
                        id={inputId}
                        name={field.id}
                        onChange={event => {
                          setFieldValues(current => ({...current, [field.id]: event.target.value}));
                          if (validationField === field.id) setValidationField(undefined);
                        }}
                        placeholder={field.placeholder}
                        required={field.required}
                        value={fieldValues[field.id] ?? ''}
                      />
                    )}
                    {field.description ? <small>{field.description}</small> : null}
                    {validationField === field.id ? <strong>Enter a value to continue.</strong> : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        <footer className="manager-dialog-actions">
          <button
            className="quiet-button"
            data-manager-dialog-initial-focus={fields.length === 0 && tone === 'danger'}
            onClick={() => props.onFinish(undefined)}
            type="button"
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            className={tone === 'danger' ? 'danger' : ''}
            data-manager-dialog-initial-focus={fields.length === 0 && tone === 'default'}
            type="submit"
          >
            {options.confirmLabel ?? 'Continue'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function initialDialogValues(fields: readonly ManagerDialogField[]): Record<string, string> {
  return EffectRecord.fromEntries(EffectArray.map(fields, field => [field.id, field.initialValue ?? '']));
}
