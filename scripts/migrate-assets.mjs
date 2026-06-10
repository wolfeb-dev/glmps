#!/usr/bin/env node
import { getPaths } from '../server/lib/paths.js';
import { migrateAssets } from '../server/lib/asset-migrate.js';

const P = getPaths();
console.log(`migrate-assets:\n  assetsDir=${P.assetsDir}\n  claudeDir=${P.claudeDir}`);
const r = migrateAssets({ assetsDir: P.assetsDir, claudeDir: P.claudeDir });
if (r.ok === false && r.reason) { console.error(`refused: ${r.reason} (${P.assetsDir})`); process.exit(2); }
console.log(`moved ${r.moved.length} item(s); backup at ${r.backupDir}`);
console.log(`deploy: linked=${r.deploy.linked.length} copied=${r.deploy.copied.length} backedUp=${r.deploy.backedUp.length}`);
if (!r.ok) {
  console.error(`VERIFY FAILED: ${r.mismatches.join(', ')}`);
  console.error(`Restore: copy ${r.backupDir}/* back into ${P.claudeDir} and remove the new links.`);
  process.exit(1);
}
console.log('OK. Initialize the private repo yourself when ready (these are git commits):');
console.log(`  cd "${P.assetsDir}" && git init && git add -A && git commit -m "chore: initial glmps assets"`);
