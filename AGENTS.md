# Telegramvisor

This service owns Telegram communication for T3: recaps, full replies, native
questionnaires, delivery/cleanup history, chat policy and explicit recovery.
Andrea wants this service on the Mac only. Do not install or deploy Telegramvisor
on Lima, or recreate its VM port forwards, without a new explicit request.
It is independent of project/workflow supervision. Never modify T3 source or its
installed app/server, introduce proxies, or import from the Supervisor repository.
Use supported native APIs and the existing MCPX Telegram bridge.

Preserve original environment, activation, delivery keys, permanent identities,
question drafts and uncertain outcomes during extraction. Never run old and new
Telegram consumers at the same time against the same input inbox. Lost acknowledgements
require reconciliation, not replay. No compatibility framework for retired prototypes.
Keep credentials, private state and runtime caches outside Git and image layers.

Run autofix and typecheck after development cycles, affected tests, and build.
Use one-line lowercase comments and English throughout. No attribution footers.
Changes include normal push/deployment and bounded live verification on the Mac
when authorized by the current task. Preserve unrelated PR ownership.

## Knowledge Base

This project has a local, git-ignored knowledge/ wiki. Read knowledge/INDEX.md and
relevant pages before codebase research; use rg and qmd lookup as appropriate.
After meaningful development, use the knowledge skill to capture durable changes.
