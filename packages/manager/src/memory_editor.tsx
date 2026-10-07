import React, {useRef, useState} from 'react';
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  toolbarPlugin,
  DiffSourceToggleWrapper,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  InsertTable,
  InsertCodeBlock,
  Separator,
} from '@mdxeditor/editor';
import {memoryDocumentParts, replaceMemoryBody} from './library_model.js';

export function MemoryEditor({
  content,
  disabled,
  onChange,
}: {
  readonly content: string;
  readonly disabled: boolean;
  readonly onChange: (content: string) => void;
}): React.ReactElement {
  const initial = useRef(memoryDocumentParts(content).body);
  const editor = useRef<MDXEditorMethods>(null);
  const [error, setError] = useState('');
  const update = (body: string) => onChange(replaceMemoryBody(content, body));
  // Unsupported Markdown stays editable verbatim instead of being silently normalized away.
  if (error)
    return (
      <div className="memory-source-fallback">
        <p role="status">This document uses formatting unavailable in rich mode. Edit its Markdown source below.</p>
        <textarea
          aria-label="Memory Markdown source"
          disabled={disabled}
          value={memoryDocumentParts(content).body}
          onChange={event => update(event.target.value)}
          spellCheck={false}
        />
      </div>
    );
  return (
    <MDXEditor
      ref={editor}
      markdown={initial.current}
      readOnly={disabled}
      className="memory-rich-editor"
      contentEditableClassName="markdown-body"
      placeholder="What should your agents remember? Use Markdown shortcuts as you write."
      onError={({error: cause}) => setError(cause)}
      onChange={(body, initialNormalize) => {
        if (!initialNormalize) update(body);
      }}
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        tablePlugin(),
        codeBlockPlugin({defaultCodeBlockLanguage: 'ts'}),
        codeMirrorPlugin({
          codeBlockLanguages: {
            '': 'Plain text',
            ts: 'TypeScript',
            tsx: 'TSX',
            js: 'JavaScript',
            json: 'JSON',
            css: 'CSS',
            python: 'Python',
            bash: 'Shell',
            sql: 'SQL',
            go: 'Go',
            rust: 'Rust',
          },
        }),
        diffSourcePlugin(),
        markdownShortcutPlugin(),
        toolbarPlugin({
          toolbarContents: () => (
            <DiffSourceToggleWrapper>
              <UndoRedo />
              <Separator />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles />
              <ListsToggle />
              <Separator />
              <CreateLink />
              <InsertTable />
              <InsertCodeBlock />
            </DiffSourceToggleWrapper>
          ),
        }),
      ]}
    />
  );
}
