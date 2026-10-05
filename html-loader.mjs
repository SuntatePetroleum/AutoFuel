// Node loader hook: lets `import x from './file.html'` work like Wrangler's Text rule.
import { readFile } from 'node:fs/promises';
export async function load(url, context, nextLoad) {
  if (url.endsWith('.html')) {
    const text = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
