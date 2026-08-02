// Installs the extensionless-import resolve hook for `node --test`.
// Used via `node --import ./test/register.mjs` — see package.json "test".
import { register } from 'node:module';
register('./resolver.mjs', import.meta.url);
