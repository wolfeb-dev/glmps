// server/lib/poison-scan.js
// Zero-dependency detection core for AI-agent poisoning signals in ingested
// text (backlog tickets, transcript-derived deferrals, memory/CLAUDE writes).
//
// Pure functions, no I/O. Two outputs:
//   scanText(text)   -> { flags, severity, clean, matches }
//   classifyTrust()  -> 'operator' | 'external'
//   scanTicket(item) -> provenance: { trust, flags, severity, quarantined, scannedAt? }
//
// Design notes:
// - "critical" flags are block-worthy (instruction override, authority spoof,
//   exfiltration-to-endpoint, embedded credentials, hidden Unicode tag chars).
// - "warn" flags are surface-worthy but common enough that they should not, on
//   their own, block an OPERATOR-authored ticket (bare URLs, memory-style
//   phrasing, zero-width chars, suspicious base64).
// - The quarantine policy intentionally treats EXTERNAL-trust content (anything
//   not authored at the operator's keyboard, e.g. transcript-derived deferral
//   tickets) more strictly: ANY flag quarantines it. This closes the
//   self-amplifying loop where injected transcript text becomes an executed job.

export const SEVERITY = { none: 0, warn: 1, critical: 2 };
const RANK = ['none', 'warn', 'critical'];

// ── Detector table: [code, severity, regex] ──────────────────────────────────
// Ordered roughly by specificity. Each detector contributes its code once.
const DETECTORS = [
  // Hidden / invisible characters first — strong signal, near-zero false positives.
  ['unicode-tag', 'critical', /[\u{E0000}-\u{E007F}]/u],
  ['zero-width', 'warn', /[​-‏⁠﻿]/u],

  // Instruction override ("ignore/disregard/forget previous instructions", "new instructions:").
  ['instruction-override', 'critical',
    /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(all\s+|any\s+|the\s+|your\s+)?(previous|prior|earlier|preceding|above|system)\b[\s\S]{0,20}\b(instruction|instructions|prompt|prompts|direction|directions|context|rules?)\b/i],
  ['instruction-override', 'critical',
    /\b(your\s+new|the\s+new|updated|real)\s+(instruction|instructions|task|objective|directive|directives)\b\s*[:\-]/i],

  // Authority spoofing / jailbreak persona.
  ['authority-spoof', 'critical',
    /\b(you\s+are\s+now|act\s+as|pretend\s+(to\s+be|you\s+are|that\s+you)|roleplay\s+as|developer\s+mode|jailbreak|do\s+anything\s+now|\bDAN\b)\b/i],
  ['authority-spoof', 'critical',
    /\b(this\s+(message|instruction|prompt|note)\s+(is|comes?)\s+from|i\s+am|message\s+from)\s+(anthropic|openai|the\s+system|system\s+admin|your\s+(developer|operator|administrator))\b/i],

  // Exfiltration: move data to an external endpoint, or attach secrets to a call.
  ['exfiltration', 'critical',
    /\b(send|post|upload|exfiltrate|transmit|forward|leak|email|curl|wget|fetch)\b[\s\S]{0,80}\b(to|at|into)\b[\s\S]{0,20}(https?:\/\/|[\w.-]+@[\w.-]+)/i],
  ['exfiltration', 'critical',
    /\b(append|include|attach|add|put)\b[\s\S]{0,40}\b(api[_\s-]?key|access[_\s-]?key|secret|token|password|credential|\.ssh|id_rsa|env\s+var|environment\s+variable)\b/i],

  // Embedded credential material.
  ['credential', 'critical',
    /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})/],
  ['credential', 'critical',
    /-----BEGIN\s+([A-Z0-9 ]+\s+)?PRIVATE KEY-----/],
  ['credential', 'critical',
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],

  // Memory-poisoning phrasing — persistence-oriented language ("remember that",
  // "from now on", "in all future sessions"). Warn: common in legit prose too.
  ['memory-injection', 'warn',
    /\b(remember\s+that|memori[sz]e\s+(that|this)|keep\s+in\s+mind\s+that|for\s+future\s+reference|from\s+now\s+on|going\s+forward|in\s+all\s+(future\s+)?sessions?|for\s+all\s+(future\s+)?sessions?)\b/i],

  // A bare external URL — context, not proof. Warn.
  ['external-url', 'warn', /\bhttps?:\/\/[^\s)<>"']+/i],
];

// Base64 blobs that decode to instruction-like text are a known smuggling trick.
const B64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const B64_KEYWORDS = /(ignore|instruction|disregard|exfiltrate|password|api[_\s-]?key|send\s+to|http)/i;

function maxSeverity(a, b) { return SEVERITY[a] >= SEVERITY[b] ? a : b; }

function detectBase64(text) {
  const runs = String(text).match(B64_RUN);
  if (!runs) return false;
  for (const run of runs) {
    try {
      const decoded = Buffer.from(run, 'base64').toString('utf-8');
      // Require mostly-printable decode to avoid flagging binary-ish blobs.
      if (B64_KEYWORDS.test(decoded)) return true;
    } catch { /* not valid base64 */ }
  }
  return false;
}

/**
 * Scan a string for poisoning signals.
 * @returns {{ flags: string[], severity: 'none'|'warn'|'critical', clean: boolean, matches: object[] }}
 */
export function scanText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { flags: [], severity: 'none', clean: true, matches: [] };
  }
  const flags = new Set();
  const matches = [];
  let severity = 'none';

  for (const [code, sev, re] of DETECTORS) {
    if (flags.has(code)) continue; // one entry per code
    const m = re.exec(text);
    if (m) {
      flags.add(code);
      severity = maxSeverity(severity, sev);
      matches.push({ code, severity: sev, sample: String(m[0]).slice(0, 80) });
    }
  }

  if (!flags.has('base64-instruction') && detectBase64(text)) {
    flags.add('base64-instruction');
    severity = maxSeverity(severity, 'warn');
    matches.push({ code: 'base64-instruction', severity: 'warn', sample: '' });
  }

  return { flags: [...flags], severity, clean: flags.size === 0, matches };
}

// Sources authored at the operator's keyboard get OPERATOR trust; anything that
// arrives via an automated/derived path (deferral feeder, AO, programmatic API
// posts) is EXTERNAL and scanned more strictly.
const OPERATOR_SOURCES = new Set(['manual', 'dashboard', 'operator']);
export function classifyTrust(source) {
  return OPERATOR_SOURCES.has(String(source ?? '')) ? 'operator' : 'external';
}

// Quarantine decision: hold (a) anything critical, or (b) any flag at all on
// external-trust content. Operator-authored warn-level content passes.
export function quarantineDecision({ trust, severity }) {
  if (severity === 'critical') return true;
  if (trust === 'external' && severity !== 'none') return true;
  return false;
}

/**
 * Produce a provenance record for a backlog ticket.
 * @returns {{ trust, flags, severity, quarantined, matches }}
 */
export function scanTicket({ title = '', prompt = '', source } = {}) {
  const trust = classifyTrust(source);
  const r = scanText(`${title}\n${prompt}`);
  return {
    trust,
    flags: r.flags,
    severity: r.severity,
    matches: r.matches,
    quarantined: quarantineDecision({ trust, severity: r.severity }),
  };
}

export { RANK };
