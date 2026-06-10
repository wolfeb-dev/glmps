// web/copy-strings.js  (plain ESM — works in browser and node:test)
export function invocationFor(item) {
  if (item.type === 'skill')
    return '/' + (item.plugin && item.plugin !== 'project' ? `${item.plugin}:${item.name}` : item.name);
  if (item.type === 'agent') return `Use the ${item.name} agent for this task`;
  if (item.type === 'memory' || item.type === 'context-file')
    return `Read ${item.path} before continuing`;
  return item.name ?? '';
}
