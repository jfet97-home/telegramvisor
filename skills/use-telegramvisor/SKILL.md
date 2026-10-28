---
name: use-telegramvisor
description: Use an existing Telegramvisor dashboard to inspect notification history, manage Telegram notification exclusions or request a fresh recovery update; explain questionnaire replies from any T3 chat and cleanup. For product usage, not source maintenance or deployment.
---

# Use Telegramvisor

Telegramvisor provides completion recaps, full answers to forwarded Telegram work,
input-needed alerts, questionnaires, reactions/cleanup and retained delivery history.
Project/workflow supervision belongs to the separate Supervisor service.

## Connect and sign in

Use the supplied instance URL; the default is http://127.0.0.1:9038. Localhost refers
to the machine running the browser. Enter an operator-provided single-use access
token privately on the page. The displayed `telegramvisor auth forge` command is
run by an authorized operator in the service environment, with matching state.
Ordinary usage does not provision credentials or change deployment/network access.

The five-minute token can be used once. The resulting eight-hour session belongs
to that exact origin and survives restart until its original expiry or Sign out.
An expired session retains the current draft; sign-in never retries a rejected
mutation automatically. Inspect an uncertain result before another write.

## History and status

History searches retained notifications by chat, kind, state and reason. Expand
Details and open the source chat when useful. Read delivery, questionnaire and
cleanup outcomes separately: a sent card is not an answered question, and accepted
input is not proof that the agent resumed or completed its work.

The status panel distinguishes T3, Telegram, recaps and questions. Refresh failures
retain older data; report its age and the current error. A ready service does not
prove a particular notification was delivered. Unknown delivery remains uncertain;
do not resend it or clear history to make the display look successful. Missing or
expired detail is unavailable evidence. A disabled service needs operator attention,
not a change to chat selection.

## Chat selection and exclusions

Automatic chat recaps are off by default for all chats. The status panel's Enable
recaps or Disable recaps button saves the choice immediately across restarts.
Change it only when requested. Enabling starts with new completions and does not
replay queued recaps or work completed while disabled. Full replies to Telegram
messages, questionnaires and input-needed notices continue independently.

Chats manages Telegram exclusions for recaps, full replies and questions. Every
non-excluded ordinary T3 chat can send interactive questionnaires to the same
Telegram bot chat. No main or interactive chat selection is needed, so resetting
the main chat does not change where another chat's answers go. Excluding a chat
retires its existing question cards and prevents their answers from being submitted.

Change only the requested choices, review the draft and choose Save chat settings.
Drafts survive section navigation. Discard draft restores the latest saved settings.
A concurrent edit or rejected save keeps the draft; refresh/reconcile before saving
again. Changes persist across restarts. Telegram exclusions do not edit the separate
Supervisor policy or disable its workflows.

## Answering questionnaires

The owner answers using the Telegram card's buttons or Reply to the registered
question. Each card identifies its source T3 chat; answers stay with that request
when several chats have pending questions. A retained plain input-needed notice is
not an interactive card. Read [questionnaire replies](references/questionnaires.md)
for text, selection, review/submission, stale cards and cleanup behavior.

## Recovery

Recovery lists retained gaps in completion coverage, including older work outside
the recent-history window of an enormous chat. Refresh coverage is read-only.
Ask chat for recovery update sends an actual fresh-assessment request and may start
a new turn in an idle chat; use it only when that follow-up is requested.

Answer pending owner questions/approvals first when recovery is deferred. An
unavailable or excluded chat is not an invitation to change policy or wake it by
another route. Accepted/reconciled recovery is retained once per chat. Check recovery
request reconciles an uncertain original attempt rather than sending it again.
After an error or rejected request, inspect the displayed outcome before retrying.
Recovery does not mark older work complete, recreate an old notification or guarantee
a new Telegram recap. Follow the source chat for the actual assessment.
