import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateDirMigration } from '../lib/paths.js';

const fsmod = (present) => ({ existsSync: (p) => present.includes(p) });

test('reports legacy migration only when legacy exists and active is absent', () => {
  assert.deepEqual(stateDirMigration({ stateDir: '/new', legacyStateDir: '/old' }, fsmod(['/old'])), { migrateFrom: '/old' });
  assert.deepEqual(stateDirMigration({ stateDir: '/new', legacyStateDir: '/old' }, fsmod(['/old', '/new'])), { migrateFrom: null });
  assert.deepEqual(stateDirMigration({ stateDir: '/new', legacyStateDir: '/old' }, fsmod([])), { migrateFrom: null });
});
