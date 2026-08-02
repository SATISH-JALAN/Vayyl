// ESM resolve hook for `node --test`.
//
// The app is bundled by Next.js, which resolves extensionless relative imports
// ('./poseidon'). Node's ESM loader does not. Rather than rewrite every import in
// the app to suit the test runner, this hook applies the bundler's resolution
// rule inside node so tests import the real modules, unmodified.
//
// Registered by test/register.mjs.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.jsx'];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !path.extname(specifier)) {
    const parentPath = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : process.cwd();

    for (const ext of EXTENSIONS) {
      const candidate = path.resolve(parentPath, specifier + ext);
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    // Directory import: './foo' -> './foo/index.ts'
    for (const ext of EXTENSIONS) {
      const candidate = path.resolve(parentPath, specifier, `index${ext}`);
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
