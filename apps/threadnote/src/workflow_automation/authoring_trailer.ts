import * as Effect2 from 'effect';
import * as EffectString from 'effect/String';

/** Opens the one-line payload trailer that ends every encoded native authoring artifact. */
export const authoringMarker = '<!-- threadnote-authoring:v1 ';

/**
 * Where the payload trailer starts: the last line-initial marker, whose line is the final line and ends with ` -->\n`.
 * The encoder writes the trailer as one line, and its stable JSON never contains a raw newline.
 */
export const authoringTrailerStart = (body: string) => {
  const start = Effect2.pipe(
    body,
    EffectString.lastIndexOf('\n' + authoringMarker),
    Effect2.Option.getOrElse(() => -1),
  );
  return start < 0 ||
    !Effect2.pipe(body, EffectString.endsWith(' -->\n')) ||
    Effect2.pipe(body, EffectString.slice(start + 1, -1), EffectString.includes('\n'))
    ? undefined
    : start;
};

/**
 * True when the decoder would find an authoring payload trailer in this body. A memory parser trims the stored body,
 * so trailing whitespace is normalized to the single final newline that every encoded artifact ends with.
 */
export const hasAuthoringTrailer = (body: string) =>
  authoringTrailerStart(Effect2.pipe(body, EffectString.trimEnd) + '\n') !== undefined;
