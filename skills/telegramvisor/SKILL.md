---
name: telegramvisor
description: Develop, deploy or troubleshoot Andrea's Telegramvisor, including T3 recaps, forwarded replies, native questionnaires, Telegram delivery history and explicit recovery.
---

# Telegramvisor

Source is `/Users/andreasimonecosta/Developer/telegramvisor`, public repository
`jfet97-home/telegramvisor`. This independent service owns all Telegram communication.
Project/workflow supervision and its MCP belong to the separate `t3-supervisor`.
Read project AGENTS.md, knowledge/INDEX.md and relevant pages before source changes.

Mac uses Docker context desktop-linux and private Compose
`~/.config/telegramvisor/compose.yaml`; dashboard9038 and health9037 bind to loopback.
Lima uses the existing Lab Dokploy workflow and versioned deployment definitions
in `/Users/andreasimonecosta/Developer/t3-lab`; forwarded dashboard19038/health19037.
Use the Lab's current-state and extraction ledger for actual installed revisions.
Normal authorized implementation batches include both deployments and bounded live
verification. Preserve the independent flags: Mac enabled, Lima disabled until changed.

Use `telegramvisor auth forge` in the service account/container for a five-minute
one-use login token. Sessions retain their original eight-hour deadline on restart.
The dashboard has History, Recovery and Chats. Mutations require the current CSRF
and session headers; never automatically replay after an uncertain response.

Preserve telegramvisor.sqlite3, telegram-input.sqlite3,
telegram-input-replies.sqlite3, thread-settings.sqlite3 and private runtime-auth.
Original environment/activation, notification cutoff, cursors, permanent identities,
outbox keys, input revisions/drafts/tombstones and uncertain outcomes are durable
state. Unknown sends/submissions reconcile under the original identity; never reset
or blindly resend. Confirmed connect-stage non-delivery alone permits existing-key
retry. A stale uncertainty expiry is not proof that a message was sent or deleted.

Use the existing `raspfet-telegram-t3` upstream through MCPX; no direct Bot API,
credential retrieval or second router. A real bridge identity check proves
reachability; ledger reads do not prove a send. Maintenance does not authorize
arbitrary diagnostic messages or answering a user's pending question.

Normal questions use strict complete native reads. Only a typed size-limit failure
selects bounded/history/exact-turn-item composition. Native request, owner and item
hashes must stay identical. Saved anchors locate records; fresh native evidence
controls submission. Missing/ambiguous terminal evidence stays unresolved and
preserves replies; cancellation is not accepted submission. Review the current
published T3 implementation before relying on pending-array completeness after an
upgrade. Never modify T3 or its installed app/server or add a proxy workaround.

Completions use complete reads normally and recent windows only after size overflow.
Historical gaps remain explicit. Recovery sends one optional fresh-status request
per eligible chat, retaining `supervisor-notice:` message identity and original
uncertainty. It cannot recreate old notification evidence. Service-owned native
`supervisor-root:` chats and their descendants are excluded; legacy roots come from
a one-time private managed-thread inventory, with no live Supervisor DB dependency.

Run package autofix/types, relevant tests and build after source changes. Keep
credentials, private state and verified runtime caches outside Git/images. Cold
extraction and rollback must stop the old consumer first; after any new send, a
rollback needs the newest communication state, never the pre-cutover snapshot.
