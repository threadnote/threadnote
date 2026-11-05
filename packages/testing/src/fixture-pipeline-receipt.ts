/** Validate already safely read bounded regular-file contents without exposing its token. */
export function fixturePipelineReceiptProvesExit(text: string, expectedToken: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return false;
    if (!('version' in value) || value.version !== 1 || !('token' in value) || value.token !== expectedToken)
      return false;
    if (!('code' in value) || !('signal' in value)) return false;
    return (
      (Number.isInteger(value.code) && value.signal === null) ||
      (value.code === null && typeof value.signal === 'string' && value.signal.length > 0)
    );
  } catch {
    return false;
  }
}
