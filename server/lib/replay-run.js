/**
 * Headless replay re-run driver.
 * Fully injectable: pass `launch` and `buildOutcome` for testing.
 */

export async function runReplay(stateDir, task, { launch, buildOutcome } = {}) {
  if (!launch) {
    const { runQueuedTask } = await import('./queue-runner.js');
    launch = (t) => runQueuedTask(stateDir, t);
  }

  if (!buildOutcome) {
    const { buildSessionOutcome } = await import('./session-outcome.js');
    buildOutcome = buildSessionOutcome;
  }

  let launchResult;
  try {
    launchResult = await launch(task);
  } catch {
    return { produced: null };
  }

  if (!launchResult) {
    return { produced: null };
  }

  const row = buildOutcome(launchResult);
  return { produced: row };
}
