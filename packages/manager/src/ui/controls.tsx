import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {ManagerAutocompleteInput} from '@threadnote/manager/dialog';
import {isMemoryKind, isMemoryStatus} from './support.js';
import type {MemoryMetadata, SelectId, TargetForm, TreeNode} from '@threadnote/manager/ui/contracts';

interface DropdownOption {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string;
}

export function TargetFields(props: {
  readonly disabled: boolean;
  readonly hideTopic?: boolean;
  readonly onChange: (value: TargetForm) => void;
  readonly openSelect?: SelectId;
  readonly projectOptions: readonly string[];
  readonly setOpenSelect: (value: SelectId | undefined) => void;
  readonly target: TargetForm;
}): React.ReactElement {
  const set = (patch: Partial<TargetForm>) => props.onChange({...props.target, ...patch});
  return (
    <div className="target-fields">
      <DropdownSelect
        disabled={props.disabled}
        id="kind"
        label="Kind"
        onChange={value => void (isMemoryKind(value) && set({kind: value}))}
        openSelect={props.openSelect}
        options={(['durable', 'handoff', 'incident', 'preference', 'smoke'] as const).map(kind => ({
          label: kind,
          value: kind,
        }))}
        setOpenSelect={props.setOpenSelect}
        value={props.target.kind}
      />
      <DropdownSelect
        disabled={props.disabled}
        id="status"
        label="Status"
        onChange={value => void (isMemoryStatus(value) && set({status: value}))}
        openSelect={props.openSelect}
        options={(['active', 'archived', 'expired', 'superseded'] as const).map(status => ({
          label: status,
          value: status,
        }))}
        setOpenSelect={props.setOpenSelect}
        value={props.target.status}
      />
      <ManagerAutocompleteInput
        allowCreate
        disabled={props.disabled}
        onChange={project => set({project})}
        options={props.projectOptions}
        placeholder="project"
        value={props.target.project}
      />
      {!props.hideTopic ? (
        <input
          aria-label="Memory topic"
          disabled={props.disabled}
          value={props.target.topic}
          onChange={event => set({topic: event.target.value})}
          placeholder="topic"
        />
      ) : null}
    </div>
  );
}

export function DropdownSelect(props: {
  readonly disabled?: boolean;
  readonly id: SelectId;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly openSelect?: SelectId;
  readonly options: readonly DropdownOption[];
  readonly setOpenSelect: (value: SelectId | undefined) => void;
  readonly value: string;
}): React.ReactElement {
  const isOpen = props.disabled !== true && props.openSelect === props.id;
  const selected = props.options.find(option => option.value === props.value);
  return (
    <div
      className="select-field"
      onBlur={event => {
        const relatedTarget = event.relatedTarget;
        if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
          props.setOpenSelect(undefined);
        }
      }}
    >
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="select-button"
        disabled={props.disabled === true}
        onClick={() => props.setOpenSelect(isOpen ? undefined : props.id)}
        type="button"
      >
        <span>{selected?.label ?? props.value}</span>
        <span aria-hidden="true" className="select-chevron" />
      </button>
      {isOpen ? (
        <div aria-label={props.label} className="select-menu" role="listbox">
          {props.options.map(option => (
            <button
              aria-selected={option.value === props.value}
              className={`select-option ${option.value === props.value ? 'is-selected' : ''}`}
              disabled={option.disabled === true}
              key={option.value}
              onClick={() => {
                props.onChange(option.value);
                props.setOpenSelect(undefined);
              }}
              role="option"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MarkdownViewer(props: {readonly markdown: string}): React.ReactElement {
  return (
    <article className="markdown-viewer">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.markdown || '_No content_'}</ReactMarkdown>
    </article>
  );
}

export function Metadata(props: {readonly metadata?: MemoryMetadata; readonly node?: TreeNode}): React.ReactElement {
  const rows: Array<[string, string | undefined]> = [
    ['kind', props.metadata?.kind],
    ['status', props.metadata?.status],
    ['project', props.metadata?.project],
    ['topic', props.metadata?.topic],
    ['source', props.metadata?.sourceAgentClient],
    ['timestamp', props.metadata?.timestamp],
    ['team', props.node?.sharedTeam],
    ['size', props.node?.size === undefined ? undefined : `${props.node.size} bytes`],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);
  return (
    <dl>
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
