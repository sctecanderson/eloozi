export function isQueryTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof value.code === 'string' ? value.code : '';
  const status = typeof value.status === 'number' ? value.status : 0;
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';

  return code === '57014'
    || status === 504
    || message.includes('statement timeout')
    || message.includes('canceling statement due to statement timeout')
    || message.includes('gateway timeout')
    || message.includes('timed out');
}
