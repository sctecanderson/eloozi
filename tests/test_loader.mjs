import { existsSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith('.') &&
    !specifier.endsWith('.ts') &&
    !specifier.endsWith('.js') &&
    !specifier.endsWith('.mjs') &&
    !specifier.endsWith('.json')
  ) {
    const parentUrl = new URL(context.parentURL);
    const candidateTs = new URL(specifier + '.ts', parentUrl);
    if (existsSync(candidateTs)) {
      return nextResolve(specifier + '.ts', context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.includes('supabase.ts')) {
    let source = result.source.toString();
    source = source.replace(/import\.meta\.env/g, '(process.env || {})');
    source = `
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://test.supabase.co";
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "test-placeholder-key";
${source}
`;
    return { ...result, source };
  }
  return result;
}
