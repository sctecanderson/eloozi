export type ContactKey = 'instagram' | 'whatsapp' | 'facebook';
export type ContactChannels = Record<ContactKey, { value: string; enabled: boolean }>;
export function parseContactChannels(value: unknown): ContactChannels | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as ContactChannels;
  return ['instagram', 'whatsapp', 'facebook'].every(k => {
    const entry = v[k as ContactKey];
    return entry && typeof entry.value === 'string' && typeof entry.enabled === 'boolean';
  }) ? v : null;
}
export function contactUrl(key: ContactKey, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (key === 'whatsapp') {
    const candidate = /^https?:\/\//i.test(value) ? (() => {
      try { const u = new URL(value); return u.hostname === 'wa.me' ? u.pathname.slice(1) : u.hostname === 'api.whatsapp.com' ? u.searchParams.get('phone') || '' : ''; } catch { return ''; }
    })() : value;
    if (!/^[+\d\s().-]+$/.test(candidate)) return null;
    const digits = candidate.replace(/\D/g, '');
    return /^\d{10,15}$/.test(digits) ? `https://wa.me/${digits}` : null;
  }
  if (key === 'instagram' && !/^https?:\/\//i.test(value)) {
    const handle = value.replace(/^@/, '');
    return /^[a-z\d_](?:[a-z\d_.]{0,28}[a-z\d_])?$/i.test(handle) && !handle.includes('..') ? `https://instagram.com/${handle}` : null;
  }
  let candidate = value;
  if (key === 'facebook' && !/^https?:\/\//i.test(value)) {
    if (!value.includes(':') && /^[a-z\d.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(value)) candidate = `https://${value}`;
    else if (/^\/?[a-z\d_.-]+$/i.test(value)) candidate = `https://facebook.com/${value.replace(/^\//, '')}`;
    else return null;
  }
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
    if (key === 'instagram' && (!['instagram.com', 'www.instagram.com'].includes(url.hostname) || !/^\/[a-z\d_.]{1,30}\/?$/i.test(url.pathname))) return null;
    return url.href;
  } catch { return null; }
}
export function visibleContactUrls(channels: ContactChannels) {
  return Object.fromEntries((['instagram', 'whatsapp', 'facebook'] as const).map(k => [k, channels[k].enabled ? contactUrl(k, channels[k].value) : null])) as Record<ContactKey, string | null>;
}
