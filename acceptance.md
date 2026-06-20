---
commands:
  - npm test
---
# Acceptance: GLMPS

"Done" for a code change in this repo means the full test suite passes: `npm test` (the zero-dep
`node --test` runner). The Stop-hook gate (`hooks/done-gate.js`) runs this whenever the working
tree is dirty and blocks stopping while it fails, so the agent keeps working instead of
self-declaring done.

This file is the frozen, machine-checkable contract. The agent must not weaken the commands it is
graded against inside a loop. Edits to this file are surfaced in the GLMPS learning loop as the
contract's iteration. To intentionally bypass the gate for a session, add a `done.skip` file at
the repo root or set `GLMPS_DONE_GATE=off`.
