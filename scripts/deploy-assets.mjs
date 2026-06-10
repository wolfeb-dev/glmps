#!/usr/bin/env node
import { getPaths } from '../server/lib/paths.js';
import { deployAssets } from '../server/lib/asset-deploy.js';

const P = getPaths();
const r = deployAssets({ assetsDir: P.assetsDir, claudeDir: P.claudeDir });
console.log(`deploy-assets: linked=${r.linked.length} copied=${r.copied.length} skipped=${r.skipped.length} backedUp=${r.backedUp.length} failed=${r.failed.length}`);
if (r.copied.length) console.log(`  copied (not live-linked; symlinks unavailable): ${r.copied.join(', ')}`);
for (const b of r.backedUp) console.log(`  backed up ${b.dest} -> ${b.backup}`);
for (const f of r.failed) console.error(`  FAILED ${f.dest}: ${f.error}`);
process.exit(r.failed.length ? 1 : 0);
