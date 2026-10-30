import {Children, isValidElement, useEffect, useId, useState} from 'react';
import ReactMarkdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as EffectString from 'effect/String';

function MermaidDiagram({source}: {readonly source: string}) {
  const id = `post-diagram-${EffectString.replace(/[^a-zA-Z0-9_-]/gu, '')(useId())}`;
  const [result, setResult] = useState<{readonly svg?: string; readonly failed?: boolean}>({});
  useEffect(() => {
    let active = true;
    setResult({});
    void import('../lib/mermaid.js')
      .then(module => module.renderMermaidSvg(source, id))
      .then(
        svg => {
          if (active) setResult({svg});
        },
        () => {
          if (active) setResult({failed: true});
        },
      );
    return () => {
      active = false;
    };
  }, [source, id]);
  return (
    <figure className="post-diagram" aria-label="Mermaid diagram">
      {result.svg ? (
        <div className="post-diagram__image" dangerouslySetInnerHTML={{__html: result.svg}} />
      ) : (
        <p role={result.failed ? 'alert' : 'status'}>
          {result.failed ? 'Diagram unavailable. Its source is available below.' : 'Rendering diagram…'}
        </p>
      )}
      <details open={result.failed}>
        <summary>Diagram source</summary>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </details>
    </figure>
  );
}

const components: Components = {
  pre: ({children: code}) => {
    const child = Children.toArray(code)[0];
    if (
      isValidElement<{readonly className?: string; readonly children?: unknown}>(child) &&
      /(?:^|\s)language-mermaid(?:\s|$)/u.test(child.props.className ?? '') &&
      typeof child.props.children === 'string'
    )
      return <MermaidDiagram source={child.props.children} />;
    return <pre>{code}</pre>;
  },
};

export function PostMarkdown({children}: {readonly children: string}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
