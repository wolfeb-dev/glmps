// server/lib/act-gate.js
// Gate for "act" surfaces (runner launch, learning approve/promote).
// Returns { ok: true } when a controllable harness (Claude Code) is detected,
// or { ok: false, status: 409, body } when only foreign harnesses are present.
// Callers bypass the gate when GLMPS_RUNNER_DRYRUN is set or GLMPS_ALLOW_ACT==='1'.

export function assertCanAct(P, adapters) {
  const canAct = adapters.some(a => {
    if (a.controllable !== true) return false;
    try { return a.detect(P).installed === true; } catch { return false; }
  });
  if (canAct) return { ok: true };
  return {
    ok: false,
    status: 409,
    body: {
      error: 'observe-only',
      detail: 'No controllable (Claude Code) harness detected for this engagement; foreign harnesses are observe + recommend only.',
    },
  };
}
