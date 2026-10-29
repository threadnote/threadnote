import React from 'react';
import {parser as javascriptParser} from '@lezer/javascript';
import {classHighlighter, highlightTree} from '@lezer/highlight';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const typescript = javascriptParser.configure({dialect: 'ts'});
const typescriptJsx = javascriptParser.configure({dialect: 'ts jsx'});
const javascriptJsx = javascriptParser.configure({dialect: 'jsx'});

function parserForPath(path?: string) {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional path handling through the split chain.
  const extension = path?.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return typescript;
    case 'tsx':
      return typescriptJsx;
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascriptParser;
    case 'jsx':
      return javascriptJsx;
    default:
      return undefined;
  }
}

export function SourceExcerpt(props: {
  readonly content: string;
  readonly path?: string;
  readonly label?: string;
}): React.ReactElement {
  const parser = parserForPath(props.path);
  const fragments: React.ReactNode[] = [];
  let cursor = 0;
  if (parser) {
    highlightTree(parser.parse(props.content), classHighlighter, (from, to, classes) => {
      if (from > cursor) fragments.push(Effect.pipe(props.content, EffectString.slice(cursor, from)));
      fragments.push(
        <span className={classes} key={from}>
          {Effect.pipe(props.content, EffectString.slice(from, to))}
        </span>,
      );
      cursor = to;
    });
  }
  if (cursor < props.content.length || !parser) fragments.push(Effect.pipe(props.content, EffectString.slice(cursor)));
  return (
    <figure className="source-excerpt">
      {props.label || props.path ? <figcaption>{props.label ?? props.path}</figcaption> : null}
      <pre>
        <code>{fragments}</code>
      </pre>
    </figure>
  );
}
