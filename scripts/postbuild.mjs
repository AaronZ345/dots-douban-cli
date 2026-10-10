import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
chmodSync(resolve('dist/index.js'),0o755);
