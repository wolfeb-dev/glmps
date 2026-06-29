import fs from 'node:fs';
import path from 'node:path';

export function shadowFile(stateDir) {
  return path.join(stateDir, 'shadow', 'log.ndjson');
}

export function recordShadow(stateDir, {
  taskClass = 'other',
  wouldFire = false,
  fired = false,
  sid = null,
} = {}) {
  const file = shadowFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({
    taskClass,
    wouldFire: !!wouldFire,
    fired: !!fired,
    sid,
    ts: new Date().toISOString(),
  });
  fs.appendFileSync(file, line + '\n', 'utf8');
}

export function shadowRates(stateDir) {
  const file = shadowFile(stateDir);
  if (!fs.existsSync(file)) return { byClass: {} };

  const raw = fs.readFileSync(file, 'utf8');
  const byClass = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }

    const cls = entry.taskClass ?? 'other';
    if (!byClass[cls]) byClass[cls] = { n: 0, _fire: 0, _counterfactual: 0 };
    byClass[cls].n++;
    if (entry.fired === true) byClass[cls]._fire++;
    if (entry.wouldFire === true) byClass[cls]._counterfactual++;
  }

  for (const cls of Object.keys(byClass)) {
    const g = byClass[cls];
    g.fireRate = g._fire / g.n;
    g.counterfactualRate = g._counterfactual / g.n;
    delete g._fire;
    delete g._counterfactual;
  }

  return { byClass };
}
