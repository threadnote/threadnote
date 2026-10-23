import React from 'react';
import ReactMarkdown, {defaultUrlTransform} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {ManagerAutocompleteInput} from '@threadnote/manager/dialog';
import {isMemoryKind, isMemoryStatus} from './support.js';
import type {MemoryMetadata, SelectId, TargetForm, TreeNode} from '@threadnote/manager/ui/contracts';
import {MermaidBlock} from '../mermaid_block.js';

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

function isMemoryLink(uri: string): boolean {
  return /^threadnote:\/\/(?:memory\/[^/?#\s]+|user\/[^/?#\s]+\/memories\/[^?#\s]+)$/.test(uri);
}

export function MarkdownViewer(props: {
  readonly markdown: string;
  readonly onOpenMemory?: (uri: string) => void;
}): React.ReactElement {
  return (
    <article className="markdown-viewer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key, node) =>
          props.onOpenMemory && node.tagName === 'a' && key === 'href' && isMemoryLink(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          pre: MarkdownCodeBlock,
          a: ({node: _node, href, ...anchorProps}) => (
            <a
              {...anchorProps}
              href={href}
              onClick={event => {
                if (props.onOpenMemory && href && isMemoryLink(href)) {
                  event.preventDefault();
                  props.onOpenMemory(href);
                }
              }}
            />
          ),
        }}
      >
        {props.markdown || '_No content_'}
      </ReactMarkdown>
    </article>
  );
}

const MarkdownCodeBlock: NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>['pre'] = ({
  node,
  children,
  ...props
}) => {
  const code = node?.children[0];
  if (
    code?.type === 'element' &&
    code.tagName === 'code' &&
    Array.isArray(code.properties.className) &&
    code.properties.className.some(value => String(value).toLowerCase() === 'language-mermaid')
  ) {
    const source = code.children.map(child => (child.type === 'text' ? child.value : '')).join('');
    return <MermaidBlock source={source} />;
  }
  return <pre {...props}>{children}</pre>;
};

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
    <dl className="metadata">
      {rows.map(([label, value]) => (
        <div key={label} className="metadata-item">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
