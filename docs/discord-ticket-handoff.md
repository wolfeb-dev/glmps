# Discord → ticket handoff (single-reply guard)

Problem (glmps-21): a Discord message can get answered **twice**. The session
that reads Discord replies inline, and if it also files the message as a backlog
ticket, the queue runner launches a *second* session that does the work (and may
reply again). Two sessions, one user message.

GLMPS has no Discord code — Discord is the external MCP plugin — so the fix is a
convention plus a small mechanism on the GLMPS side that makes the handoff
explicit and single.

## The convention (for the session reading Discord)

When you decide to hand a Discord message off to the backlog instead of doing it
inline, do **both** of these:

1. File the ticket with an `origin` that captures the Discord context:

   ```
   POST /api/backlog
   { "project": "...", "title": "...", "prompt": "...",
     "origin": { "via": "discord", "chatId": "<chat_id>", "messageId": "<message_id>", "user": "<user>" } }
   ```

2. Do **not** reply inline. The handoff is the answer. Acknowledge briefly if you
   must (e.g. a reaction), but the substantive reply belongs to the launched
   session so the user gets exactly one.

If instead you answer inline, do not file a ticket for the same message.

## The mechanism (GLMPS side)

- Backlog items carry an optional `origin` object (`server/lib/backlog-store.js`),
  passed through `POST /api/backlog`.
- When the runner launches a job whose `origin.via === 'discord'` (and a
  `chatId` is present), the seed header (`launchHeader` in
  `server/lib/queue-runner.js`) tells the launched session that it **owns the
  reply**: reply to that Discord chat when done, and do not assume the user has
  already received an answer. That makes the launched session the single point of
  reply.

## Notes

- A Discord message is untrusted external content, so a discord-origin ticket is
  still poison-scanned at intake like any other (see
  `docs/agent-poisoning-safeguards.md`). The handoff guard is about *who replies*,
  not trust — the two are independent.
- `origin` is generic; the same field can mark other handoff channels later. The
  handoff line only fires for `via === 'discord'` with a `chatId`.
