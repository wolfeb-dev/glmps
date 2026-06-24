import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTranscriptForGaps } from '../lib/transcript-gaps.js';

// ---------------------------------------------------------------------------
// Fixture helpers — build raw JSONL lines as strings
// ---------------------------------------------------------------------------

function assistantLine(toolUses) {
  // toolUses is an array of { name, input } objects
  const content = toolUses.map(tu => ({
    type: 'tool_use',
    name: tu.name,
    input: tu.input ?? {},
  }));
  return JSON.stringify({ type: 'assistant', message: { content } });
}

function bashLine(command) {
  return assistantLine([{ name: 'Bash', input: { command } }]);
}

function grepToolLine() {
  return assistantLine([{ name: 'Grep', input: { pattern: 'foo' } }]);
}

function agentLine(subagent_type, model) {
  const input = { subagent_type, prompt: 'do something' };
  if (model !== undefined) input.model = model;
  return assistantLine([{ name: 'Agent', input }]);
}

function taskLine(subagent_type, model) {
  const input = { subagent_type, prompt: 'do something' };
  if (model !== undefined) input.model = model;
  return assistantLine([{ name: 'Task', input }]);
}

// A single assistant message that contains TWO agent dispatches in one content array
function parallelAgentLine() {
  return assistantLine([
    { name: 'Agent', input: { subagent_type: 'Explore', prompt: 'a' } },
    { name: 'Agent', input: { subagent_type: 'Explore', prompt: 'b' } },
  ]);
}

// ---------------------------------------------------------------------------
// bash-grep-over-grep-tool
// ---------------------------------------------------------------------------

test('bash-grep-over-grep-tool: flags when bg>=5 and bg > gt*3', () => {
  const lines = [
    ...Array.from({ length: 5 }, () => bashLine('grep foo bar.txt')),
    // zero Grep tool uses — gt=0, bg=5, 5 > 0*3=0 and bg>=5 -> should flag
  ];
  const result = scanTranscriptForGaps(lines);
  const hit = result.find(g => g.code === 'bash-grep-over-grep-tool');
  assert.ok(hit, 'expected bash-grep-over-grep-tool gap');
  assert.equal(hit.severity, 'info');
  assert.match(hit.message, /Bash grep used 5x vs Grep tool 0x/);
});

test('bash-grep-over-grep-tool: does not flag when gt is proportionally high', () => {
  const lines = [
    ...Array.from({ length: 5 }, () => bashLine('grep foo bar.txt')),
    // 2 Grep tool uses -> bg=5, gt=2 -> 5 > 2*3=6 is FALSE -> no flag
    grepToolLine(),
    grepToolLine(),
  ];
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'bash-grep-over-grep-tool'));
});

test('bash-grep-over-grep-tool: does not flag when bg<5', () => {
  const lines = [
    ...Array.from({ length: 4 }, () => bashLine('grep foo bar.txt')),
  ];
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'bash-grep-over-grep-tool'));
});

test('bash-grep-over-grep-tool: git grep does not count as bash grep', () => {
  // git grep should be excluded
  const lines = [
    ...Array.from({ length: 5 }, () => bashLine('git grep foo')),
  ];
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'bash-grep-over-grep-tool'));
});

// ---------------------------------------------------------------------------
// opus-on-mechanical
// ---------------------------------------------------------------------------

test('opus-on-mechanical: flags when >=5 subagent dispatches inherit Opus (no model set)', () => {
  const lines = Array.from({ length: 5 }, () => agentLine('Explore'));
  const result = scanTranscriptForGaps(lines);
  const hit = result.find(g => g.code === 'opus-on-mechanical');
  assert.ok(hit, 'expected opus-on-mechanical gap');
  assert.equal(hit.severity, 'info');
  assert.match(hit.message, /5 subagent dispatch/);
});

test('opus-on-mechanical: flags when model explicitly set to opus', () => {
  const lines = Array.from({ length: 5 }, () => agentLine('Explore', 'claude-opus-4-5'));
  const result = scanTranscriptForGaps(lines);
  assert.ok(result.some(g => g.code === 'opus-on-mechanical'));
});

test('opus-on-mechanical: does not flag when model is sonnet for all dispatches', () => {
  const lines = Array.from({ length: 5 }, () => agentLine('Explore', 'claude-sonnet-4-5'));
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'opus-on-mechanical'));
});

test('opus-on-mechanical: does not flag fewer than 5 dispatches', () => {
  const lines = Array.from({ length: 4 }, () => agentLine('Explore'));
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'opus-on-mechanical'));
});

test('opus-on-mechanical: Task tool_use also counts as subagent dispatch', () => {
  const lines = Array.from({ length: 5 }, () => taskLine('Explore'));
  const result = scanTranscriptForGaps(lines);
  assert.ok(result.some(g => g.code === 'opus-on-mechanical'));
});

// ---------------------------------------------------------------------------
// serial-agents-no-parallel
// ---------------------------------------------------------------------------

test('serial-agents-no-parallel: flags when >=3 dispatches all serial', () => {
  // Each agent dispatch in its own assistant message = serial
  const lines = [
    agentLine('Explore'),
    agentLine('Explore'),
    agentLine('Explore'),
  ];
  const result = scanTranscriptForGaps(lines);
  const hit = result.find(g => g.code === 'serial-agents-no-parallel');
  assert.ok(hit, 'expected serial-agents-no-parallel gap');
  assert.equal(hit.severity, 'info');
  assert.match(hit.message, /3 subagent dispatch/);
});

test('serial-agents-no-parallel: does not flag when one message has >=2 agent dispatches', () => {
  const lines = [
    agentLine('Explore'),
    parallelAgentLine(),   // 2 dispatches in one message
    agentLine('Explore'),
  ];
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'serial-agents-no-parallel'));
});

test('serial-agents-no-parallel: does not flag when fewer than 3 total dispatches', () => {
  const lines = [
    agentLine('Explore'),
    agentLine('Explore'),
  ];
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'serial-agents-no-parallel'));
});

// ---------------------------------------------------------------------------
// sleep-poll
// ---------------------------------------------------------------------------

test('sleep-poll: flags when any bash command has sleep N', () => {
  const lines = [bashLine('sleep 5 && curl http://example.com')];
  const result = scanTranscriptForGaps(lines);
  const hit = result.find(g => g.code === 'sleep-poll');
  assert.ok(hit, 'expected sleep-poll gap');
  assert.equal(hit.severity, 'warn');
  assert.match(hit.message, /sleep-poll detected/);
});

test('sleep-poll: does not flag when no sleep commands', () => {
  const lines = [bashLine('npm test'), bashLine('node server.js')];
  const result = scanTranscriptForGaps(lines);
  assert.ok(!result.some(g => g.code === 'sleep-poll'));
});

// ---------------------------------------------------------------------------
// backtest-result-without-skeptic
// ---------------------------------------------------------------------------

// Opt-in via ctx.backtestProjects (config-driven). A configured substring match
// arms the gap; an empty/absent list leaves it dormant (generic install default).

test('backtest-result-without-skeptic: flags a configured project with a sortino mention', () => {
  const lines = [
    JSON.stringify({ type: 'tool_result', content: 'sortino ratio: 2.3' }),
  ];
  const result = scanTranscriptForGaps(lines, { project: 'my-quant-lab', backtestProjects: ['quant'] });
  const hit = result.find(g => g.code === 'backtest-result-without-skeptic');
  assert.ok(hit, 'expected backtest-result-without-skeptic gap');
  assert.equal(hit.severity, 'warn');
  assert.match(hit.message, /Backtest result without a backtest-skeptic pass/);
});

test('backtest-result-without-skeptic: flags a configured project with a sharpe mention', () => {
  const lines = [
    JSON.stringify({ text: 'sharpe 1.8 train' }),
  ];
  const result = scanTranscriptForGaps(lines, { project: 'my-quant-lab', backtestProjects: ['quant'] });
  assert.ok(result.some(g => g.code === 'backtest-result-without-skeptic'));
});

test('backtest-result-without-skeptic: does not flag when backtest-skeptic mentioned', () => {
  const lines = [
    JSON.stringify({ text: 'sortino 2.1' }),
    JSON.stringify({ text: 'backtest-skeptic passed' }),
  ];
  const result = scanTranscriptForGaps(lines, { project: 'my-quant-lab', backtestProjects: ['quant'] });
  assert.ok(!result.some(g => g.code === 'backtest-result-without-skeptic'));
});

test('backtest-result-without-skeptic: does not flag a project not in the configured list', () => {
  const lines = [
    JSON.stringify({ text: 'sortino 2.1' }),
  ];
  const result = scanTranscriptForGaps(lines, { project: 'web-app', backtestProjects: ['quant'] });
  assert.ok(!result.some(g => g.code === 'backtest-result-without-skeptic'));
});

test('backtest-result-without-skeptic: dormant when backtestProjects is unconfigured (default)', () => {
  const lines = [
    JSON.stringify({ text: 'sortino 2.1' }),
  ];
  const result = scanTranscriptForGaps(lines, { project: 'my-quant-lab' });
  assert.ok(!result.some(g => g.code === 'backtest-result-without-skeptic'));
});

test('backtest-result-without-skeptic: does not flag when no backtest keywords', () => {
  const lines = [
    JSON.stringify({ text: 'some random text' }),
  ];
  const result = scanTranscriptForGaps(lines, { project: 'my-quant-lab', backtestProjects: ['quant'] });
  assert.ok(!result.some(g => g.code === 'backtest-result-without-skeptic'));
});

// ---------------------------------------------------------------------------
// Clean transcript
// ---------------------------------------------------------------------------

test('clean transcript returns empty array', () => {
  const lines = [
    assistantLine([{ name: 'Read', input: { file_path: '/foo/bar.js' } }]),
    grepToolLine(),
    grepToolLine(),
  ];
  assert.deepEqual(scanTranscriptForGaps(lines), []);
});

// ---------------------------------------------------------------------------
// Input robustness
// ---------------------------------------------------------------------------

test('accepts a single newline-delimited string instead of array', () => {
  const block = [bashLine('npm test'), grepToolLine()].join('\n');
  const result = scanTranscriptForGaps(block);
  assert.ok(Array.isArray(result));
});

test('skips unparseable lines without throwing', () => {
  const lines = ['not json', '{broken', '{"type": "ok"}'];
  assert.doesNotThrow(() => scanTranscriptForGaps(lines));
});

test('empty/null/undefined input returns [] without throwing', () => {
  assert.deepEqual(scanTranscriptForGaps([]), []);
  assert.deepEqual(scanTranscriptForGaps(''), []);
  assert.doesNotThrow(() => scanTranscriptForGaps(null));
  assert.doesNotThrow(() => scanTranscriptForGaps(undefined));
});

// ---------------------------------------------------------------------------
// reread-loop (raw Read tool_use counts — extract-claude emits no read events)
// ---------------------------------------------------------------------------

const readLine = (fp) => assistantLine([{ name: 'Read', input: { file_path: fp } }]);

test('reread-loop: same file read > 8 times is flagged', () => {
  const lines = [];
  for (let i = 0; i < 9; i++) lines.push(readLine('D:/x/map.js'));
  const g = scanTranscriptForGaps(lines).find(x => x.code === 'reread-loop');
  assert.ok(g, 'expected reread-loop gap');
  assert.match(g.message, /map\.js 9 times/);
});

test('reread-loop: 8 reads or fewer is not flagged (conservative)', () => {
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push(readLine('D:/x/map.js'));
  const g = scanTranscriptForGaps(lines).find(x => x.code === 'reread-loop');
  assert.equal(g, undefined);
});
