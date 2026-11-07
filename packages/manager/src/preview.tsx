import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {TreeNode} from './ui/contracts.js';
import {LibraryArticle} from './library_article.js';
import {Metadata} from './ui/controls.js';
import {memoryDocumentParts} from './library_model.js';
import * as EffectString from 'effect/String';

export interface MemoryPreviewDocument {
  readonly content: string;
  readonly node: TreeNode;
  readonly memoryId?: string;
}

const style = `
:root{color-scheme:dark;font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#10141c;color:#e7eaf0}
*{box-sizing:border-box}body{margin:0;padding:36px 24px}.preview-shell{max-width:1000px;margin:auto;border:1px solid #2c3440;border-radius:12px;overflow:hidden;background:#11161f}
.preview-top{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid #2c3440;padding:18px 24px;color:#a7b0bf;font-size:14px}
.preview-top strong{font-weight:500;overflow-wrap:anywhere}.preview-body{padding:28px clamp(22px,6vw,72px)}
.memory-tags{display:flex;gap:8px;margin-bottom:24px}.memory-tag{display:inline-flex;align-items:center;gap:7px;padding:4px 10px;border:1px solid #334052;border-radius:6px;color:#b9c3d1;font-size:13px;text-transform:capitalize}.memory-tag svg,.memory-document-footer svg{width:15px;height:15px}
.library-article h2{font-size:27px;line-height:1.3;margin:0 0 24px}.markdown-viewer{font-size:16px;overflow-wrap:anywhere}.markdown-viewer h1,.markdown-viewer h2,.markdown-viewer h3{line-height:1.25;margin:28px 0 14px}.markdown-viewer h1{font-size:26px}.markdown-viewer h2{font-size:22px}.markdown-viewer h3{font-size:19px}.markdown-viewer p,.markdown-viewer ul,.markdown-viewer ol{margin:0 0 18px}.markdown-viewer li{margin:6px 0}.markdown-viewer a{color:#9dc5ff}.markdown-viewer pre{overflow:auto;background:#0a0e15;padding:16px;border-radius:8px}.markdown-viewer code{background:#0b1018;border:1px solid #344153;border-radius:5px;padding:1px 5px}.markdown-viewer pre code{border:0;padding:0}.markdown-viewer blockquote{border-left:3px solid #59687c;margin:18px 0;padding-left:16px;color:#bac4d2}.markdown-viewer hr{border:0;border-top:1px solid #364051}.markdown-viewer table{border-collapse:collapse;display:block;overflow:auto}.markdown-viewer th,.markdown-viewer td{border:1px solid #364051;padding:6px 10px}
.memory-document-footer{display:flex;align-items:center;gap:8px;color:#8e9aaa;border-top:1px solid #2c3440;margin-top:30px;padding-top:18px;font-size:13px}.memory-document-footer time{margin-left:auto}
details{border-top:1px solid #2c3440;padding:16px 0;margin-top:26px;color:#a7b0bf}summary{cursor:pointer}.metadata{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.metadata-item{min-width:0}.metadata-item dt{font-size:12px;text-transform:uppercase;color:#8390a0}.metadata-item dd{margin:0;overflow-wrap:anywhere}
.preview-error{padding:36px clamp(22px,6vw,72px)}.preview-error h1{font-size:24px}.preview-error p{color:#b9c3d1}
@media(max-width:600px){body{padding:0}.preview-shell{border:0;border-radius:0;min-height:100vh}.preview-top{padding:14px 20px}.preview-body{padding:24px 20px}}
`;

function PreviewFrame({children, title}: {readonly children: React.ReactNode; readonly title: string}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title>{`${title} · Threadnote`}</title>
        <style>{style}</style>
      </head>
      <body>
        <main className="preview-shell">
          <header className="preview-top">
            <strong>Threadnote memory</strong>
            <span>Read only</span>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}

export function renderMemoryPreview(document: MemoryPreviewDocument): string {
  const markdown = EffectString.trimStart(memoryDocumentParts(document.content).body);
  return (
    '<!doctype html>' +
    renderToStaticMarkup(
      <PreviewFrame title={document.node.metadata?.topic ?? document.node.name}>
        <div className="preview-body">
          <LibraryArticle
            node={document.node}
            metadata={document.node.metadata}
            markdown={markdown}
            resource={false}
            readOnly
          />
          <details>
            <summary>Memory details</summary>
            <Metadata metadata={document.node.metadata} node={document.node} />
            <dl className="metadata">
              <div className="metadata-item">
                <dt>Canonical URI</dt>
                <dd>{document.node.uri}</dd>
              </div>
              {document.memoryId ? (
                <div className="metadata-item">
                  <dt>Memory ID</dt>
                  <dd>{document.memoryId}</dd>
                </div>
              ) : null}
            </dl>
          </details>
        </div>
      </PreviewFrame>,
    )
  );
}

export function renderMemoryPreviewError(): string {
  return (
    '<!doctype html>' +
    renderToStaticMarkup(
      <PreviewFrame title="Memory unavailable">
        <div className="preview-error">
          <h1>Memory unavailable</h1>
          <p>This memory could not be opened on this device. It may have moved, expired, or been removed.</p>
          <p>Try opening the memory link again. If it still fails, run threadnote doctor.</p>
        </div>
      </PreviewFrame>,
    )
  );
}
