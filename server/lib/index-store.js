// server/lib/index-store.js
import fs from 'node:fs';
import path from 'node:path';

export class IndexStore {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const r of arr) this.records.set(r.id, r);
    } catch {}
    this._dirty = false;
  }

  get(id) { return this.records.get(id); }

  upsert(id, fields) {
    const rec = this.records.get(id) ?? { id, skillsUsed: [], eventCount: 0 };
    Object.assign(rec, fields);
    this.records.set(id, rec);
    this._dirty = true;
    return rec;
  }

  applyEvents(id, events) {
    const rec = this.upsert(id, {});
    for (const e of events) {
      rec.eventCount += 1;
      rec.lastTs = e.ts ?? rec.lastTs;
      if (e.kind === 'skill' && e.label && !rec.skillsUsed.includes(e.label))
        rec.skillsUsed.push(e.label);
      if (!rec.title && e.kind === 'tool' && /^User: /.test(e.label ?? ''))
        rec.title = e.label.slice(6, 126);
    }
    this._dirty = true;
  }

  list(filter = {}) {
    let out = [...this.records.values()];
    if (filter.tool) out = out.filter(r => r.tool === filter.tool);
    if (filter.cwd) out = out.filter(r => r.cwd === filter.cwd);
    if (filter.skill) out = out.filter(r => (r.skillsUsed ?? []).includes(filter.skill));
    if (filter.sinceTs) out = out.filter(r => (r.lastTs ?? 0) >= filter.sinceTs);
    return out.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  }

  flush() {
    if (!this._dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.records.values()]));
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }
}
