import { spawnSync } from 'node:child_process';

const [script, ...args] = process.argv.slice(2);
const major = Number(process.versions.node.split('.')[0]);
const nodeArgs = major >= 24 ? ['--use-env-proxy', script, ...args] : [script, ...args];

const res = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });
process.exit(res.status ?? 1);
