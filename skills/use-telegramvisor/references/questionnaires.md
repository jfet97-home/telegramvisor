# Questionnaire replies

An interactive card belongs to one native request in the selected chat. Use its
question navigation and choose the intended question before entering an answer.
Single-choice and multiple-choice controls follow that question's options. Text
answers use Telegram's Reply action on the registered question view: swipe or
long-press the card, then type and send. The optional How to type my answer? control
only explains Reply; tapping it is not required. Unquoted ordinary messages are not
native answers. A tool-sent bot message is not an owner reply or callback.

Navigation changes the displayed question. A registered older quoted view can still
identify its original question; do not assume the currently visible question owns
every reply. Ambiguous, obsolete or cleared answers are rejected instead of guessed.
Clear is a real answer-state change; an old reply must not restore a cleared answer.

Review shows the draft batch. Submit is the separate action that sends it to the
original native request. Draft entries and receipt reactions do not establish native
acceptance. A stale/replaced request or changed question requires the current card;
do not re-enter or resubmit simply because the previous receipt is missing.
Unknown submission is reconciled under the original identity, never blindly replayed.
Do not fabricate callback/inbox events or bypass the card's validation.

After confirmed accepted/resolved input, the service can retire the card and clean
up the owner's answer attempts. Cancellation, archival or replacement without that
proof retains unsubmitted text. Cleanup can be pending, uncertain, expired or
impossible; those are distinct from successful deletion. Missing message IDs or
expired evidence cannot be presented as a deleted card. Inspect retained history
when the Telegram view and native chat appear out of sync.

Other ordinary chats receive plain input-needed alerts. Open the source chat to
answer there; replying to that alert does not answer its native question. Delegated
and service-owned conversations and permission approvals are outside this relay.
