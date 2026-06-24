// Acceptance-gate oracle for proposed capability-reminder rules.
// A rule is a regex string; it must match every prompt where the capability
// was missed (missedPrompts) and match none of the held-out prompts where
// it should stay silent (heldOutPrompts).
//
// Returns { ok, matchedMissed, overMatched, [error] }
//   ok           – true only when all missed matched + none held-out matched
//                  + at least one missed prompt exists
//   matchedMissed – count of missedPrompts the regex matched
//   overMatched  – subset (array) of heldOutPrompts the regex matched
//   error        – 'invalid-regex' if the pattern could not be compiled

export function validateRule(regexStr, missedPrompts = [], heldOutPrompts = []) {
  let re;
  try {
    re = new RegExp(regexStr, 'i');
  } catch {
    return { ok: false, matchedMissed: 0, overMatched: [], error: 'invalid-regex' };
  }

  const missed = Array.isArray(missedPrompts) ? missedPrompts : [];
  const heldOut = Array.isArray(heldOutPrompts) ? heldOutPrompts : [];

  const matchedMissed = missed.filter(p => re.test(String(p))).length;
  const overMatched = heldOut.filter(p => re.test(String(p)));

  const ok = missed.length > 0 && matchedMissed === missed.length && overMatched.length === 0;

  return { ok, matchedMissed, overMatched };
}
