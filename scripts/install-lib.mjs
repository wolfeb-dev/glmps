// scripts/install-lib.mjs — pure, testable helpers for the GLMPS installer.
// No fs/os side effects here: every function takes plain JS objects/strings and
// returns plain results, so it can be unit-tested without touching ~/.claude.

const MARKER = 'capability-reminder.js';

// Does a UserPromptSubmit matcher-group contain a command including `marker`?
function groupHasCommand(group, marker) {
  const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
  return hooks.some((h) => typeof h?.command === 'string' && h.command.includes(marker));
}

// Append the capability-reminder UserPromptSubmit hook group to a settings
// object. Idempotent: if a group already references capability-reminder.js,
// `patched` is the unchanged input and `alreadyInstalled` is true.
// `hookCommand` is the full `node "<abs>"` string.
export function buildHookPatch(settings, hookCommand) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const events = src.hooks && typeof src.hooks === 'object' ? src.hooks : {};
  const ups = Array.isArray(events.UserPromptSubmit) ? events.UserPromptSubmit : [];

  if (ups.some((g) => groupHasCommand(g, MARKER))) {
    return { patched: settings, alreadyInstalled: true };
  }

  const group = { hooks: [{ type: 'command', command: hookCommand }] };
  const patched = {
    ...src,
    hooks: { ...events, UserPromptSubmit: [...ups, group] },
  };
  return { patched, alreadyInstalled: false };
}

// Remove any UserPromptSubmit group whose command includes `marker`. Cleans up
// an empty UserPromptSubmit array and an empty hooks object. `removed` is the
// count of groups stripped.
export function removeHookPatch(settings, marker) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const events = src.hooks && typeof src.hooks === 'object' ? src.hooks : null;
  const ups = Array.isArray(events?.UserPromptSubmit) ? events.UserPromptSubmit : null;
  if (!ups) return { patched: settings, removed: 0 };

  const kept = ups.filter((g) => !groupHasCommand(g, marker));
  const removed = ups.length - kept.length;
  if (removed === 0) return { patched: settings, removed: 0 };

  const nextEvents = { ...events };
  if (kept.length) nextEvents.UserPromptSubmit = kept;
  else delete nextEvents.UserPromptSubmit;

  const patched = { ...src };
  if (Object.keys(nextEvents).length) patched.hooks = nextEvents;
  else delete patched.hooks;

  return { patched, removed };
}
