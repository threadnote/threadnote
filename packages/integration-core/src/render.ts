export function splitUtf8(value: string, maxBytes: number): readonly string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new RangeError('Invalid chunk byte limit.');
  const chunks: string[] = [];
  let chunk = '';
  let size = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (size + width > maxBytes && chunk !== '') {
      chunks.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += character;
    size += width;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}
