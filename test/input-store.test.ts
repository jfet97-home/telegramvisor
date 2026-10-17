import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  emptyInputAnswers,
  INPUT_MAX_ANSWERS_JSON_BYTES,
  INPUT_MAX_CHOICES,
  INPUT_MAX_QUESTIONS,
  INPUT_MAX_REQUEST_JSON_BYTES,
  makeInputId,
  normalizeInputRequest,
  renderInputBatch,
} from "../src/input-domain.js";
import type { InputEvent, NativeInputRequest } from "../src/input-domain.js";
import {
  InputStore,
  INPUT_CLEANUP_UNCERTAINTY_TTL_MS,
  INPUT_DELETE_MAX_AGE_MS,
  makeInputStore,
} from "../src/input-store.js";
import { renderInputCard } from "../src/input-ui.js";

const request: NativeInputRequest = {
  threadId: "thread-1",
  requestId: "request-1",
  revisionHash: "revision-1",
  capability: "question-response",
  terminal: false,
  terminalState: null,
  questions: [
    { id: "q1", prompt: "Pick one", kind: "single_choice", required: true, allowCustomAnswer: true, choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { id: "q2", prompt: "Add context", kind: "free_text", required: false, allowCustomAnswer: true, choices: [] },
  ],
};

const withStore = async <A>(run: (store: InputStore, directory: string) => Promise<A> | A): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-store-"));
  const store = makeInputStore(directory);
  try { return await run(store, directory); }
  finally {
    try { store.close(); } catch { /* store may have been reopened by the test */ }
    await rm(directory, { recursive: true, force: true });
  }
};

const event = (messageId: number, overrides: Partial<InputEvent> = {}): InputEvent => ({
  eventId: "event-1",
  updateId: 1,
  updateEpoch: 0,
  messageId,
  inputId: makeInputId("env-1", request.threadId, request.requestId),
  requestRevision: request.revisionHash,
  draftRevision: 0,
  questionId: "q1",
  action: "select",
  value: "a",
  ...overrides,
});

const prepareSentGeneration = (store: InputStore, now: number, messageIdStart = 100) => {
  const tracked = store.upsertRequest("env-1", request, now);
  const rendered = renderInputBatch({ request, answers: emptyInputAnswers() });
  const messages = store.ensureGeneration(tracked.inputId, request.revisionHash, 0, rendered, now);
  assert.ok(messages);
  for (const message of messages) {
    assert.equal(store.beginMessageSend(message.deliveryKey, now), true);
    assert.equal(store.recordMessageSent(message.deliveryKey, messageIdStart + message.ordinal, now + 10), true);
  }
  return store.getRequest(tracked.inputId, request.revisionHash)!;
};

const sendGeneration = (store: InputStore, messages: NonNullable<ReturnType<InputStore["ensureGeneration"]>>, now: number, firstMessageId: number) => {
  for (const message of messages) {
    assert.equal(store.beginMessageSend(message.deliveryKey, now), true);
    assert.equal(store.recordMessageSent(message.deliveryKey, firstMessageId + message.ordinal, now + 1), true);
  }
  const first = messages[0];
  return first
    ? store.messagesForRequest(first.inputId, first.requestRevision).filter((message) => message.generation === first.generation)
    : [];
};

test("private SQLite database reopens with environment and input identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-permissions-"));
  let store = makeInputStore(directory);
  try {
    store.bindEnvironment("env-1");
    store.upsertRequest("env-1", request, 1_000);
    store.close();
    const database = await stat(join(directory, "telegram-input.sqlite3"));
    assert.equal(database.mode & 0o777, 0o600);
    store = makeInputStore(directory);
    assert.throws(() => store.bindEnvironment("other-env"));
    const row = store.getRequest(makeInputId("env-1", request.threadId, request.requestId), request.revisionHash);
    assert.equal(row?.environmentId, "env-1");
    assert.equal(row?.lifecycle, "active");
  } finally {
    try { store.close(); } catch { /* the previous store was closed before reopen */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("original focus history survives navigation and reopen while the displayed question resets focus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-focus-identity-"));
  let store = makeInputStore(directory);
  let now = 1_800;
  const inputId = makeInputId("env-1", request.threadId, request.requestId);
  try {
    store.upsertRequest("env-1", request, now++);
    const publish = () => {
      const current = store.getRequest(inputId, request.revisionHash)!;
      const rendered = renderInputCard({
        request,
        answers: current.answers,
        presentation: current.presentation,
        draftRevision: current.draftRevision,
        presentationRevision: current.presentationRevision,
      });
      const prepared = store.ensurePresentation(
        inputId,
        request.revisionHash,
        current.draftRevision,
        current.presentationRevision,
        current.presentation,
        rendered,
        now++,
      );
      assert.ok(prepared);
      assert.equal(store.beginMessageSend(prepared.deliveryKey, now++), true);
      assert.equal(store.recordMessagePresented(prepared.deliveryKey, 520, now++), true);
      return store.messagesForRequest(inputId, request.revisionHash)
        .find((message) => message.deliveryKey === prepared.deliveryKey)!;
    };
    const action = (view: ReturnType<typeof publish>, eventId: string, updateId: number, overrides: Partial<InputEvent>) =>
      store.applyEvent(event(view.messageId!, {
        eventId,
        updateId,
        draftRevision: view.draftRevision,
        questionId: view.questionId,
        deliveryKey: view.deliveryKey,
        presentationRevision: view.presentationRevision,
        ...overrides,
      }), now++);

    let view = publish();
    assert.equal(view.focusId, null);
    assert.deepEqual(action(view, "focus-q1", 1, { action: "edit_text", focusId: "focus-q1-exact" }), {
      kind: "presented", draftRevision: 0, presentationRevision: 2,
    });
    const focusView = publish();
    assert.equal(focusView.focusId, "focus-q1-exact");
    assert.equal(store.getRequest(inputId, request.revisionHash)?.presentation.focusId, "focus-q1-exact");

    assert.equal(action(focusView, "navigate-q2", 2, { action: "navigate", value: "question:1:0" }).kind, "presented");
    view = publish();
    assert.equal(view.questionId, "q2");
    assert.equal(view.focusId, null);
    store.close();
    store = makeInputStore(directory);
    assert.equal(store.getRequest(inputId, request.revisionHash)?.presentation.focusId, null);
    view = store.messagesForRequest(inputId, request.revisionHash).find((message) => message.generation ===
      store.getRequest(inputId, request.revisionHash)?.currentGeneration)!;
    assert.equal(view.focusId, null);

    assert.equal(action(view, "review-q1-focus", 3, { action: "review", questionId: "q2", value: "review:0" }).kind, "presented");
    const review = publish();
    assert.equal(review.questionId, null);
    assert.equal(review.focusId, null);
    assert.equal(action(review, "return-q2", 4, { action: "navigate", questionId: null, value: "question:1:0" }).kind, "presented");
    const q2 = publish();
    assert.equal(q2.questionId, "q2");
    assert.equal(q2.focusId, null);
    assert.equal(action(q2, "focus-q2", 5, { action: "edit_text", questionId: "q2", focusId: "focus-q2-exact" }).kind, "presented");
    const newFocusView = publish();
    assert.equal(newFocusView.focusId, "focus-q2-exact");
    assert.equal(store.getRequest(inputId, request.revisionHash)?.presentation.focusId, "focus-q2-exact");
    const history = store.messagesForRequest(inputId, request.revisionHash);
    assert.ok(history.some((message) => message.focusId === "focus-q1-exact"));
    assert.ok(history.some((message) => message.focusId === "focus-q2-exact"));
  } finally {
    try { store.close(); } catch { /* store may have been reopened by the test */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy focus presentation and input message rows migrate to empty exact focus identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-focus-migration-"));
  let store = makeInputStore(directory);
  try {
    const tracked = store.upsertRequest("env-1", request, 1_850);
    const rendered = renderInputCard({
      request,
      answers: tracked.answers,
      presentation: { kind: "question", questionIndex: 0, page: 0, focusQuestionId: "q1", focusId: "focus-before-migration" },
      draftRevision: 0,
      presentationRevision: tracked.presentationRevision,
    });
    assert.throws(() => store.ensurePresentation(
      tracked.inputId, request.revisionHash, 0, tracked.presentationRevision,
      { kind: "question", questionIndex: 0, page: 0, focusQuestionId: "q1", focusId: "focus-before-migration" },
      { ...rendered, focusId: "different-focus" }, 1_851,
    ), /text focus/u);
    const prepared = store.ensurePresentation(
      tracked.inputId, request.revisionHash, 0, tracked.presentationRevision,
      { kind: "question", questionIndex: 0, page: 0, focusQuestionId: "q1", focusId: "focus-before-migration" },
      rendered, 1_851,
    );
    assert.ok(prepared);
    assert.equal(prepared.focusId, "focus-before-migration");
    store.close();

    const database = new DatabaseSync(join(directory, "telegram-input.sqlite3"));
    database.prepare("UPDATE input_requests SET presentation_json=? WHERE input_id=? AND request_revision=?")
      .run(JSON.stringify({ kind: "question", questionIndex: 0, page: 0, focusQuestionId: "q1" }), tracked.inputId, request.revisionHash);
    database.exec("ALTER TABLE input_messages DROP COLUMN focus_id");
    database.close();

    store = makeInputStore(directory);
    const migrated = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(migrated.presentation.focusQuestionId, "q1");
    assert.equal(migrated.presentation.focusId, null);
    assert.equal(store.messagesForRequest(tracked.inputId, request.revisionHash)[0]?.focusId, null);
  } finally {
    try { store.close(); } catch { /* store may have been reopened by the test */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("renaming chat display context updates rendering metadata without invalidating the request", async () => {
  await withStore(async (store) => {
    const original = store.upsertRequest("env-1", { ...request, displayTitle: "Original chat" }, 1_500);
    const renamed = store.upsertRequest("env-1", { ...request, displayTitle: "Renamed chat" }, 1_510);
    assert.equal(renamed.inputId, original.inputId);
    assert.equal(renamed.definitionHash, original.definitionHash);
    assert.equal(renamed.lifecycle, "active");
    assert.equal(renamed.request.displayTitle, "Renamed chat");
  });
});

test("callback application is durable, deduplicated, and rejects stale message generations", async () => {
  await withStore(async (store) => {
    const now = 2_000;
    const tracked = prepareSentGeneration(store, now);
    const currentMessage = store.messagesForRequest(tracked.inputId, request.revisionHash).find((item) => item.questionId === "q1")!;
    const applied = store.applyEvent(event(currentMessage.messageId!), now + 20);
    assert.deepEqual(applied, { kind: "changed", draftRevision: 1 });
    const after = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(after.answers.q1?.value, "a");
    assert.equal(after.draftRevision, 1);
    assert.equal(store.applyEvent(event(currentMessage.messageId!), now + 21).kind, "duplicate");
    const newGeneration = store.ensureGeneration(
      tracked.inputId,
      request.revisionHash,
      1,
      renderInputBatch({ request, answers: after.answers }),
      now + 22,
    );
    assert.ok(newGeneration);
    const stale = store.applyEvent(event(currentMessage.messageId!, { eventId: "old-render", draftRevision: 0, updateId: 3, value: "b" }), now + 23);
    assert.deepEqual(stale, { kind: "ignored", reason: "stale_question", draftRevision: 1 });
    assert.equal(store.getRequest(tracked.inputId, request.revisionHash)?.answers.q1?.value, "a");
  });
});

test("different questions accept answers from the same displayed batch while stale same-question operations are rejected", async () => {
  await withStore(async (store) => {
    const tracked = prepareSentGeneration(store, 2_500);
    const messages = store.messagesForRequest(tracked.inputId, request.revisionHash);
    const choiceMessage = messages.find((item) => item.questionId === "q1")!;
    const textMessage = messages.find((item) => item.questionId === "q2")!;
    const first = store.applyEvent(event(choiceMessage.messageId!, {
      eventId: "choice-newer", updateId: 10, value: "b",
    }), 2_510);
    assert.deepEqual(first, { kind: "changed", draftRevision: 1 });
    const second = store.applyEvent(event(textMessage.messageId!, {
      eventId: "text-same-batch", updateId: 11, draftRevision: 0, questionId: "q2", action: "answer",
      text: "Context", contributionId: "context-reply",
    }), 2_511);
    assert.deepEqual(second, { kind: "changed", draftRevision: 2 });
    const afterBoth = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(afterBoth.answers.q1?.value, "b");
    assert.equal(afterBoth.answers.q2?.value, "Context");

    const staleSameQuestion = store.applyEvent(event(choiceMessage.messageId!, {
      eventId: "choice-older", updateId: 9, value: "a",
    }), 2_512);
    assert.deepEqual(staleSameQuestion, { kind: "ignored", reason: "stale_question", draftRevision: 2 });
    assert.equal(store.getRequest(tracked.inputId, request.revisionHash)?.answers.q1?.value, "b");
  });
});

test("reset epoch ordering survives restart and adds the epoch column to an older database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-order-reset-"));
  let store = makeInputStore(directory);
  try {
    const tracked = prepareSentGeneration(store, 2_600);
    const firstCard = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .find((item) => item.questionId === "q2")!;
    const first = store.applyEvent(event(firstCard.messageId!, {
      eventId: "high-before-reset", updateId: 2_000_000_000, updateEpoch: 0,
      action: "answer", questionId: "q2", text: "Before reset", contributionId: "before-reset",
    }), 2_610);
    assert.deepEqual(first, { kind: "changed", draftRevision: 1 });
    store.close();

    const database = new DatabaseSync(join(directory, "telegram-input.sqlite3"));
    database.exec("ALTER TABLE input_events DROP COLUMN update_epoch");
    database.close();
    store = makeInputStore(directory);
    const oldDraft = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(oldDraft.answers.q2?.updateEpoch, 0);
    assert.equal(store.applyEvent(event(firstCard.messageId!, {
      eventId: "high-before-reset", updateId: 2_000_000_000, updateEpoch: 0,
      action: "answer", questionId: "q2", text: "Before reset", contributionId: "before-reset",
    }), 2_620).kind, "duplicate");

    const resetGeneration = store.ensureGeneration(
      tracked.inputId, request.revisionHash, 1,
      renderInputBatch({ request, answers: oldDraft.answers }), 2_630,
    )!;
    const resetCard = resetGeneration.find((item) => item.questionId === "q2")!;
    const resetMessageId = 800 + resetCard.ordinal;
    store.beginMessageSend(resetCard.deliveryKey, 2_631);
    store.recordMessageSent(resetCard.deliveryKey, resetMessageId, 2_632);
    assert.deepEqual(store.applyEvent(event(resetMessageId, {
      eventId: "low-after-reset", updateId: 123, updateEpoch: 1, draftRevision: 1,
      action: "answer", questionId: "q2", text: "After reset", contributionId: "after-reset",
    }), 2_640), { kind: "changed", draftRevision: 2 });
    store.close();

    store = makeInputStore(directory);
    const afterRestart = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(afterRestart.answers.q2?.value, "After reset");
    assert.equal(afterRestart.answers.q2?.updateId, 123);
    assert.equal(afterRestart.answers.q2?.updateEpoch, 1);
    const latestGeneration = store.ensureGeneration(
      tracked.inputId, request.revisionHash, 2,
      renderInputBatch({ request, answers: afterRestart.answers }), 2_650,
    )!;
    const latestCard = latestGeneration.find((item) => item.questionId === "q2")!;
    const latestMessageId = 900 + latestCard.ordinal;
    store.beginMessageSend(latestCard.deliveryKey, 2_651);
    store.recordMessageSent(latestCard.deliveryKey, latestMessageId, 2_652);
    assert.deepEqual(store.applyEvent(event(latestMessageId, {
      eventId: "old-epoch-late-answer", updateId: 1_999_999_999, updateEpoch: 0, draftRevision: 2,
      action: "answer", questionId: "q2", text: "Late old update", contributionId: "late-old",
    }), 2_660), { kind: "ignored", reason: "reordered_event", draftRevision: 2 });
    assert.equal(store.getRequest(tracked.inputId, request.revisionHash)?.answers.q2?.value, "After reset");
  } finally {
    try { store.close(); } catch { /* the store may already be closed before a restart */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("the current text contribution remains editable after its source card is deleted", async () => {
  await withStore(async (store) => {
    const tracked = prepareSentGeneration(store, 2_700);
    const sourceCard = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .find((item) => item.questionId === "q2")!;
    const first = store.applyEvent(event(sourceCard.messageId!, {
      eventId: "owned-text", action: "answer", questionId: "q2", text: "First draft",
      contributionId: "owned-contribution",
    }), 2_710);
    assert.equal(first.kind, "changed");
    store.acknowledgeEvents(["owned-text"], 2_711);
    const changed = store.getRequest(tracked.inputId, request.revisionHash)!;
    const rerendered = store.ensureGeneration(
      tracked.inputId, request.revisionHash, changed.draftRevision,
      renderInputBatch({ request, answers: changed.answers }), 2_720,
    )!;
    for (const item of rerendered) {
      store.beginMessageSend(item.deliveryKey, 2_721);
      store.recordMessageSent(item.deliveryKey, 500 + item.ordinal, 2_722);
    }
    const replacementCard = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .find((item) => item.generation === rerendered[0]?.generation && item.questionId === "q2")!;
    const foreignCardEdit = store.applyEvent(event(replacementCard.messageId!, {
      eventId: "foreign-card-edit", updateId: 2, draftRevision: 1, action: "answer", questionId: "q2",
      text: "Foreign edit", contributionId: "owned-contribution", edited: true,
    }), 2_723);
    assert.deepEqual(foreignCardEdit, {
      kind: "ignored", reason: "contribution_source_mismatch", draftRevision: 1,
    });

    const pendingCleanup = store.dueCleanupMessages(2_724).find((item) => item.deliveryKey === sourceCard.deliveryKey);
    assert.ok(pendingCleanup);
    assert.equal(store.beginMessageDeletion(pendingCleanup.deliveryKey, 2_725), true);
    assert.equal(store.recordMessageDeleted(pendingCleanup.deliveryKey, 2_726), true);
    assert.equal(store.messagesForRequest(tracked.inputId, request.revisionHash)
      .some((item) => item.messageId === sourceCard.messageId), false);

    const edit = store.applyEvent(event(sourceCard.messageId!, {
      eventId: "edit-owned-text", updateId: 3, draftRevision: 0, action: "answer", questionId: "q2",
      text: "Corrected draft", contributionId: "owned-contribution", edited: true,
    }), 2_730);
    assert.deepEqual(edit, { kind: "changed", draftRevision: 2 });
    const afterEdit = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(afterEdit.answers.q2?.value, "Corrected draft");
    assert.equal(afterEdit.answers.q2?.contributionId, "owned-contribution");

    store.acknowledgeEvents(["foreign-card-edit", "edit-owned-text"], 2_731);
    const current = store.ensureGeneration(
      tracked.inputId, request.revisionHash, afterEdit.draftRevision,
      renderInputBatch({ request, answers: afterEdit.answers }), 2_732,
    )!;
    for (const item of current) {
      store.beginMessageSend(item.deliveryKey, 2_733);
      store.recordMessageSent(item.deliveryKey, 600 + item.ordinal, 2_734);
    }
    const currentTextCard = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .find((item) => item.generation === current[0]?.generation && item.questionId === "q2")!;
    const replacement = store.applyEvent(event(currentTextCard.messageId!, {
      eventId: "replacement-text", updateId: 4, draftRevision: 2, action: "answer", questionId: "q2",
      text: "Replacement answer", contributionId: "replacement-contribution",
    }), 2_735);
    assert.deepEqual(replacement, { kind: "changed", draftRevision: 3 });
    store.acknowledgeEvents(["replacement-text"], 2_736);
    const supersededEdit = store.applyEvent(event(sourceCard.messageId!, {
      eventId: "edit-superseded-text", updateId: 5, draftRevision: 0, action: "answer", questionId: "q2",
      text: "Edited superseded answer", contributionId: "owned-contribution", edited: true,
    }), 2_737);
    assert.deepEqual(supersededEdit, { kind: "ignored", reason: "stale_question", draftRevision: 3 });
    assert.equal(store.getRequest(tracked.inputId, request.revisionHash)?.answers.q2?.value, "Replacement answer");
  });
});

test("active card identities survive replacement cleanup and restart while stale actions stay scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-card-identities-"));
  let store = makeInputStore(directory);
  try {
    const multiRequest = normalizeInputRequest({
      ...request,
      requestId: "late-card-actions",
      revisionHash: "late-card-actions-revision",
      questions: [
        { id: "multi", prompt: "Choose any", kind: "multi_choice", required: true, allowCustomAnswer: false,
          choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
        { id: "notes", prompt: "Notes", kind: "free_text", required: false, allowCustomAnswer: true, choices: [] },
      ],
    });
    const inputId = makeInputId("env-1", multiRequest.threadId, multiRequest.requestId);
    store.upsertRequest("env-1", multiRequest, 2_800);
    const originalPrepared = store.ensureGeneration(inputId, multiRequest.revisionHash, 0,
      renderInputBatch({ request: multiRequest, answers: emptyInputAnswers() }), 2_801)!;
    const original = sendGeneration(store, originalPrepared, 2_802, 700);
    const originalMulti = original.find((message) => message.questionId === "multi")!;
    const originalNotes = original.find((message) => message.questionId === "notes")!;
    assert.deepEqual(store.applyEvent(event(originalMulti.messageId!, {
      eventId: "late-select-a", inputId, requestRevision: multiRequest.revisionHash,
      questionId: "multi", action: "select", value: "a", updateId: 1,
    }), 2_804), { kind: "changed", draftRevision: 1 });
    store.acknowledgeEvents(["late-select-a"], 2_805);

    const afterA = store.getRequest(inputId, multiRequest.revisionHash)!;
    const replacementPrepared = store.ensureGeneration(inputId, multiRequest.revisionHash, afterA.draftRevision,
      renderInputBatch({ request: multiRequest, answers: afterA.answers }), 2_806)!;
    const replacement = sendGeneration(store, replacementPrepared, 2_807, 800);
    const oldSubmit = replacement.find((message) => message.questionId === null)!;
    assert.ok(oldSubmit);
    const originalRows = store.messagesForRequest(inputId, multiRequest.revisionHash)
      .filter((message) => message.generation === original[0]!.generation);
    assert.ok(originalRows.every((message) => message.cleanupState === "pending"));
    for (const message of store.dueCleanupMessages(2_809)) {
      assert.equal(store.beginMessageDeletion(message.deliveryKey, 2_810), true);
      assert.equal(store.recordMessageDeleted(message.deliveryKey, 2_811), true);
    }
    assert.equal(store.messagesForRequest(inputId, multiRequest.revisionHash)
      .some((message) => message.messageId === originalMulti.messageId), false);
    store.close();
    store = makeInputStore(directory);

    assert.deepEqual(store.applyEvent(event(originalMulti.messageId!, {
      eventId: "late-select-b", inputId, requestRevision: multiRequest.revisionHash,
      questionId: "multi", action: "select", value: "b", updateId: 2,
    }), 2_812), { kind: "changed", draftRevision: 2 });
    assert.deepEqual(store.getRequest(inputId, multiRequest.revisionHash)?.answers.multi?.value, ["a", "b"]);
    assert.deepEqual(store.applyEvent(event(originalMulti.messageId!, {
      eventId: "reordered-old-a", inputId, requestRevision: multiRequest.revisionHash,
      questionId: "multi", action: "deselect", value: "a", updateId: 0,
    }), 2_813), { kind: "ignored", reason: "reordered_event", draftRevision: 2 });
    assert.deepEqual(store.applyEvent(event(originalNotes.messageId!, {
      eventId: "late-text-reply", inputId, requestRevision: multiRequest.revisionHash,
      questionId: "notes", action: "answer", text: "Still current", contributionId: "late-text", updateId: 3,
    }), 2_814), { kind: "changed", draftRevision: 3 });
    assert.equal(store.getRequest(inputId, multiRequest.revisionHash)?.answers.notes?.value, "Still current");

    assert.deepEqual(store.applyEvent(event(oldSubmit.messageId!, {
      eventId: "old-deleted-submit", inputId, requestRevision: multiRequest.revisionHash,
      questionId: null, action: "submit", draftRevision: oldSubmit.draftRevision, updateId: 4,
    }), 2_815), { kind: "ignored", reason: "stale_presentation", draftRevision: 3 });

    const foreignRequest = { ...multiRequest, requestId: "foreign-card", revisionHash: "foreign-card-revision" };
    const foreignId = makeInputId("env-1", foreignRequest.threadId, foreignRequest.requestId);
    store.upsertRequest("env-1", foreignRequest, 2_816);
    const foreignPrepared = store.ensureGeneration(foreignId, foreignRequest.revisionHash, 0,
      renderInputBatch({ request: foreignRequest, answers: emptyInputAnswers() }), 2_817)!;
    const foreignMessages = sendGeneration(store, foreignPrepared, 2_818, 900);
    const foreignCard = foreignMessages.find((message) => message.questionId === "multi")!;
    assert.deepEqual(store.applyEvent(event(foreignCard.messageId!, {
      eventId: "foreign-card-action", inputId, requestRevision: multiRequest.revisionHash,
      questionId: "multi", action: "select", value: "a", updateId: 5,
    }), 2_820), { kind: "ignored", reason: "message_not_registered", draftRevision: 3 });

    store.setRequestTerminal(inputId, multiRequest.revisionHash, 2_821);
    assert.deepEqual(store.applyEvent(event(originalMulti.messageId!, {
      eventId: "terminal-card-action", inputId, requestRevision: multiRequest.revisionHash,
      questionId: "multi", action: "select", value: "a", updateId: 6,
    }), 2_822), { kind: "ignored", reason: "request_not_editable", draftRevision: 3 });
  } finally {
    try { store.close(); } catch { /* the previous store may have been closed before a restart */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("a full 80-choice keyboard fits storage at both typical and maximum value sizes", async () => {
  await withStore(async (store) => {
    const makeChoiceRequest = (requestId: string, valueLength: number): NativeInputRequest => normalizeInputRequest({
      ...request,
      requestId,
      revisionHash: `${requestId}-revision`,
      questions: [{
        id: "large",
        prompt: "Choose one",
        kind: "single_choice",
        required: true,
        allowCustomAnswer: false,
        choices: Array.from({ length: INPUT_MAX_CHOICES }, (_, index) => ({
          value: `${String(index).padStart(2, "0")}${"v".repeat(valueLength - 2)}`,
          label: `Choice ${index + 1}`,
        })),
      }],
    });
    const typicalRequest = makeChoiceRequest("typical-values", 500);
    const typicalTracked = store.upsertRequest("env-1", typicalRequest, 3_100);
    const typicalRendered = renderInputBatch({ request: typicalRequest, answers: emptyInputAnswers() });
    assert.ok(Buffer.byteLength(JSON.stringify(typicalRendered[0]?.buttons), "utf8") > 32 * 1024);
    const typicalMessages = store.ensureGeneration(
      typicalTracked.inputId, typicalRequest.revisionHash, 0, typicalRendered, 3_101,
    );
    assert.equal(typicalMessages?.[0]?.buttons.length, INPUT_MAX_CHOICES);

    const maximumRequest = makeChoiceRequest("maximum-values", 2_048);
    assert.ok(Buffer.byteLength(JSON.stringify(maximumRequest), "utf8") <= INPUT_MAX_REQUEST_JSON_BYTES);
    const maximumTracked = store.upsertRequest("env-1", maximumRequest, 3_102);
    const maximumRendered = renderInputBatch({ request: maximumRequest, answers: emptyInputAnswers() });
    const maximumKeyboardBytes = Buffer.byteLength(JSON.stringify(maximumRendered[0]?.buttons), "utf8");
    assert.ok(maximumKeyboardBytes > 32 * 1024);
    const maximumMessages = store.ensureGeneration(
      maximumTracked.inputId, maximumRequest.revisionHash, 0, maximumRendered, 3_103,
    );
    assert.equal(maximumMessages?.[0]?.buttons.length, INPUT_MAX_CHOICES);
    assert.deepEqual(maximumMessages?.[0]?.buttons.map((row) => row[0]?.value),
      maximumRequest.questions[0]?.choices.map((choice) => choice.value));
  });
});

test("all 80 maximum-size choices remain independently selectable and submit their exact native values", async () => {
  await withStore(async (store) => {
    const multiRequest = normalizeInputRequest({
      ...request,
      requestId: "all-maximum-options",
      revisionHash: "all-maximum-options-revision",
      questions: [{
        id: "many",
        prompt: "Choose every applicable option",
        kind: "multi_choice",
        required: true,
        allowCustomAnswer: false,
        choices: Array.from({ length: INPUT_MAX_CHOICES }, (_, index) => ({
          value: `${String(index).padStart(2, "0")}${"v".repeat(2_046)}`,
          label: `Choice ${index + 1}`,
        })),
      }],
    });
    assert.ok(Buffer.byteLength(JSON.stringify(multiRequest), "utf8") <= INPUT_MAX_REQUEST_JSON_BYTES);
    const tracked = store.upsertRequest("env-1", multiRequest, 3_200);
    const prepared = store.ensureGeneration(tracked.inputId, multiRequest.revisionHash, 0,
      renderInputBatch({ request: multiRequest, answers: emptyInputAnswers() }), 3_201)!;
    const generation = sendGeneration(store, prepared, 3_202, 1_000);
    const card = generation.find((message) => message.questionId === "many")!;
    for (const [index, choice] of multiRequest.questions[0]!.choices.entries()) {
      const result = store.applyEvent(event(card.messageId!, {
        eventId: `maximum-option-${index}`,
        inputId: tracked.inputId,
        requestRevision: multiRequest.revisionHash,
        draftRevision: 0,
        questionId: "many",
        action: "select",
        value: choice.value,
        updateId: index + 1,
      }), 3_210 + index);
      assert.deepEqual(result, { kind: "changed", draftRevision: index + 1 });
    }
    const saved = store.getRequest(tracked.inputId, multiRequest.revisionHash)!;
    assert.equal(Array.isArray(saved.answers.many?.value) ? saved.answers.many.value.length : -1, INPUT_MAX_CHOICES);
    assert.ok(Buffer.byteLength(JSON.stringify(saved.answers), "utf8") < INPUT_MAX_ANSWERS_JSON_BYTES);
    const intent = store.prepareSubmission(tracked.inputId, multiRequest.revisionHash, INPUT_MAX_CHOICES, 3_300);
    assert.deepEqual(intent?.answers, { many: multiRequest.questions[0]!.choices.map((choice) => choice.value) });
  });
});

test("32 maximum-length Unicode answers survive restart and native submission storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-max-answers-"));
  let store = makeInputStore(directory);
  try {
    const textRequest = normalizeInputRequest({
      ...request,
      requestId: "maximum-unicode-answers",
      revisionHash: "maximum-unicode-answers-revision",
      questions: Array.from({ length: INPUT_MAX_QUESTIONS }, (_, index) => ({
        id: `question-${index}`,
        prompt: `Question ${index}`,
        kind: "free_text",
        required: true,
        allowCustomAnswer: true,
        choices: [],
      })),
    });
    const tracked = store.upsertRequest("env-1", textRequest, 3_400);
    const prepared = store.ensureGeneration(tracked.inputId, textRequest.revisionHash, 0,
      renderInputBatch({ request: textRequest, answers: emptyInputAnswers() }), 3_401)!;
    const generation = sendGeneration(store, prepared, 3_402, 2_000);
    const answer = "\u0000\u4e00".repeat(2_048);
    assert.equal(answer.length, 4_096);
    for (const [index, question] of textRequest.questions.entries()) {
      const card = generation.find((message) => message.questionId === question.id)!;
      assert.deepEqual(store.applyEvent(event(card.messageId!, {
        eventId: `maximum-text-${index}`,
        inputId: tracked.inputId,
        requestRevision: textRequest.revisionHash,
        draftRevision: 0,
        questionId: question.id,
        action: "answer",
        text: answer,
        contributionId: `maximum-contribution-${index}`,
        updateId: index + 1,
      }), 3_410 + index), { kind: "changed", draftRevision: index + 1 });
    }
    const saved = store.getRequest(tracked.inputId, textRequest.revisionHash)!;
    assert.ok(Buffer.byteLength(JSON.stringify(saved.answers), "utf8") > 512 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(saved.answers), "utf8") < INPUT_MAX_ANSWERS_JSON_BYTES);
    store.close();
    store = makeInputStore(directory);
    const reopened = store.getRequest(tracked.inputId, textRequest.revisionHash)!;
    assert.equal(reopened.draftRevision, INPUT_MAX_QUESTIONS);
    assert.ok(textRequest.questions.every((question) => reopened.answers[question.id]?.value === answer));
    const intent = store.prepareSubmission(tracked.inputId, textRequest.revisionHash, INPUT_MAX_QUESTIONS, 3_500);
    assert.ok(intent);
    assert.ok(textRequest.questions.every((question) => intent.answers[question.id] === answer));
  } finally {
    try { store.close(); } catch { /* the previous store may have been closed before a restart */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("submit intent survives restart as unknown and cannot be blindly retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-submit-"));
  let store = makeInputStore(directory);
  try {
    const tracked = prepareSentGeneration(store, 4_000);
    const message = store.messagesForRequest(tracked.inputId, request.revisionHash).find((item) => item.questionId === "q1")!;
    store.applyEvent(event(message.messageId!, { eventId: "select", updateId: 1 }), 4_020);
    const changed = store.getRequest(tracked.inputId, request.revisionHash)!;
    const rendered = renderInputBatch({ request, answers: changed.answers });
    const generation = store.ensureGeneration(tracked.inputId, request.revisionHash, 1, rendered, 4_030)!;
    for (const item of generation) {
      store.beginMessageSend(item.deliveryKey, 4_031);
      store.recordMessageSent(item.deliveryKey, 400 + item.ordinal, 4_032);
    }
    const submit = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .find((item) => item.generation === generation[0]?.generation && item.questionId === null)!;
    const submitEvent = event(submit.messageId!, {
      eventId: "submit", updateId: 2, draftRevision: 1, questionId: null, action: "submit",
    });
    assert.deepEqual(store.applyEvent(submitEvent, 4_040), { kind: "submit", draftRevision: 1 });
    const intent = store.prepareSubmission(tracked.inputId, request.revisionHash, 1, 4_041);
    assert.deepEqual(intent?.answers, { q1: "a" });
    store.close();
    store = makeInputStore(directory);
    const recovered = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(recovered.submissionState, "unknown");
    assert.equal(recovered.lifecycle, "active");
    assert.equal(store.prepareSubmission(tracked.inputId, request.revisionHash, 1, 5_000), null);
    assert.equal(store.applyEvent(submitEvent, 5_000).kind, "ignored");
  } finally {
    try { store.close(); } catch { /* store may already be closed */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-batch multi-select events merge across options in the durable reducer", async () => {
  await withStore(async (store) => {
    const multiRequest: NativeInputRequest = {
      ...request,
      revisionHash: "multi-revision",
      questions: [{
        id: "multi", prompt: "Choose all", kind: "multi_choice", required: true, allowCustomAnswer: false,
        choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      }],
    };
    const tracked = store.upsertRequest("env-1", multiRequest, 2_400);
    const rendered = renderInputBatch({ request: multiRequest, answers: emptyInputAnswers() });
    const generation = store.ensureGeneration(tracked.inputId, multiRequest.revisionHash, 0, rendered, 2_401)!;
    const card = generation[0]!;
    store.beginMessageSend(card.deliveryKey, 2_402);
    store.recordMessageSent(card.deliveryKey, 450, 2_403);
    const first = store.applyEvent(event(450, {
      eventId: "select-a", requestRevision: multiRequest.revisionHash, questionId: "multi", value: "a", updateId: 1,
    }), 2_404);
    assert.deepEqual(first, { kind: "changed", draftRevision: 1 });
    const second = store.applyEvent(event(450, {
      eventId: "select-b", requestRevision: multiRequest.revisionHash, questionId: "multi", value: "b", updateId: 2,
    }), 2_405);
    assert.deepEqual(second, { kind: "changed", draftRevision: 2 });
    assert.deepEqual(store.getRequest(tracked.inputId, multiRequest.revisionHash)?.answers.multi?.value, ["a", "b"]);
  });
});

test("clear preserves answer ordering and contribution barriers across epochs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-clear-barrier-"));
  const store = makeInputStore(directory);
  try {
    const clearRequest: NativeInputRequest = {
      ...request,
      requestId: "clear-barrier",
      revisionHash: "clear-barrier-revision",
      questions: [{
        id: "multi", prompt: "Choose all", kind: "multi_choice", required: true, allowCustomAnswer: true,
        choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
      }],
    };
    const inputId = makeInputId("env-1", clearRequest.threadId, clearRequest.requestId);
    store.upsertRequest("env-1", clearRequest, 2_450);
    const publish = (now: number) => {
      const current = store.getRequest(inputId, clearRequest.revisionHash)!;
      const rendered = renderInputCard({
        request: clearRequest,
        answers: current.answers,
        presentation: current.presentation,
        draftRevision: current.draftRevision,
        presentationRevision: current.presentationRevision,
      });
      const prepared = store.ensurePresentation(
        inputId,
        clearRequest.revisionHash,
        current.draftRevision,
        current.presentationRevision,
        current.presentation,
        rendered,
        now,
      );
      assert.ok(prepared);
      assert.equal(store.beginMessageSend(prepared.deliveryKey, now), true);
      assert.equal(store.recordMessagePresented(prepared.deliveryKey, 450, now + 1), true);
      return store.messagesForRequest(inputId, clearRequest.revisionHash)
        .find((message) => message.deliveryKey === prepared.deliveryKey)!;
    };
    const makeEvent = (view: ReturnType<typeof publish>, overrides: Partial<InputEvent>): InputEvent => ({
      eventId: "clear-event",
      updateId: 1,
      updateEpoch: 0,
      messageId: 450,
      inputId,
      requestRevision: clearRequest.revisionHash,
      draftRevision: view.draftRevision,
      questionId: "multi",
      action: "select",
      value: "a",
      deliveryKey: view.deliveryKey,
      presentationRevision: view.presentationRevision,
      ...overrides,
    });

    const original = publish(2_451);
    assert.deepEqual(store.applyEvent(makeEvent(original, {
      eventId: "focus-before-clear", updateId: 10, action: "edit_text", focusId: "focus-before-clear",
    }), 2_453), { kind: "presented", draftRevision: 0, presentationRevision: 2 });
    const focused = publish(2_454);
    assert.deepEqual(store.applyEvent(makeEvent(focused, {
      eventId: "answer-before-clear", updateId: 11, action: "answer", text: "Old custom answer",
      contributionId: "reply-before-clear", focusId: "focus-before-clear",
      focusPresentationRevision: original.presentationRevision,
    }), 2_456), { kind: "changed", draftRevision: 1 });
    const answered = publish(2_457);
    assert.deepEqual(store.applyEvent(makeEvent(answered, {
      eventId: "clear-answer", updateId: 2, updateEpoch: 1, action: "clear",
    }), 2_459), { kind: "changed", draftRevision: 2 });

    const cleared = store.getRequest(inputId, clearRequest.revisionHash)!;
    assert.equal(cleared.answers.multi, undefined);
    assert.deepEqual(cleared.answerTombstones.multi, {
      updateId: 2,
      updateEpoch: 1,
      draftRevision: 2,
      presentationRevision: 4,
      contributionId: "reply-before-clear",
    });
    const afterClear = publish(2_460);
    assert.deepEqual(store.applyEvent(makeEvent(original, {
      eventId: "old-epoch-option", updateId: 999, updateEpoch: 0, action: "select", value: "b",
    }), 2_462), { kind: "ignored", reason: "stale_after_clear", draftRevision: 2 });
    assert.deepEqual(store.applyEvent(makeEvent(afterClear, {
      eventId: "edit-cleared-contribution", updateId: 3, updateEpoch: 1, action: "answer",
      text: "Edited old answer", contributionId: "reply-before-clear", edited: true,
      focusId: "focus-before-clear", focusPresentationRevision: original.presentationRevision,
    }), 2_463), { kind: "ignored", reason: "stale_after_clear", draftRevision: 2 });
    assert.equal(store.getRequest(inputId, clearRequest.revisionHash)?.answers.multi, undefined);

    assert.deepEqual(store.applyEvent(makeEvent(afterClear, {
      eventId: "new-option-b", updateId: 4, updateEpoch: 1, action: "select", value: "b",
    }), 2_464), { kind: "changed", draftRevision: 3 });
    assert.deepEqual(store.applyEvent(makeEvent(afterClear, {
      eventId: "new-option-a", updateId: 5, updateEpoch: 1, action: "select", value: "a",
    }), 2_465), { kind: "changed", draftRevision: 4 });
    assert.deepEqual(store.getRequest(inputId, clearRequest.revisionHash)?.answers.multi?.value, ["a", "b"]);

    const current = publish(2_466);
    assert.deepEqual(store.applyEvent(makeEvent(current, {
      eventId: "new-focus-after-clear", updateId: 6, updateEpoch: 1, action: "edit_text", focusId: "focus-after-clear",
    }), 2_468), { kind: "presented", draftRevision: 4, presentationRevision: current.presentationRevision + 1 });
    const newFocusView = publish(2_469);
    assert.deepEqual(store.applyEvent(makeEvent(newFocusView, {
      eventId: "new-answer-after-clear", updateId: 7, updateEpoch: 1, action: "answer", text: "New answer",
      contributionId: "new-reply", focusId: "focus-after-clear", focusPresentationRevision: current.presentationRevision,
    }), 2_471), { kind: "changed", draftRevision: 5 });
    assert.equal(store.getRequest(inputId, clearRequest.revisionHash)?.answers.multi?.customText, "New answer");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy request rows gain empty answer tombstones without losing active answers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-clear-migration-"));
  let store = makeInputStore(directory);
  try {
    const tracked = prepareSentGeneration(store, 2_480);
    const card = store.messagesForRequest(tracked.inputId, request.revisionHash).find((message) => message.questionId === "q1")!;
    assert.equal(store.applyEvent(event(card.messageId!, {
      eventId: "legacy-answer", updateId: 1, value: "a",
    }), 2_482).kind, "changed");
    store.close();

    const database = new DatabaseSync(join(directory, "telegram-input.sqlite3"));
    database.exec("ALTER TABLE input_requests DROP COLUMN answer_tombstones_json");
    database.close();
    store = makeInputStore(directory);

    const migrated = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.deepEqual(migrated.answerTombstones, {});
    assert.equal(migrated.answers.q1?.value, "a");
    assert.equal(migrated.draftRevision, 1);
  } finally {
    try { store.close(); } catch { /* the previous store was closed before reopen */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy raw-value option ordering migrates to compact identifiers without losing ordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-option-order-migration-"));
  let store = makeInputStore(directory);
  try {
    const multiRequest: NativeInputRequest = {
      ...request,
      requestId: "legacy-option-order",
      revisionHash: "legacy-option-order-revision",
      questions: [{
        id: "multi", prompt: "Choose all", kind: "multi_choice", required: true, allowCustomAnswer: false,
        choices: [{ value: `${"a".repeat(2_048)}`, label: "A" }, { value: "b", label: "B" }],
      }],
    };
    const tracked = store.upsertRequest("env-1", multiRequest, 3_600);
    const prepared = store.ensureGeneration(tracked.inputId, multiRequest.revisionHash, 0,
      renderInputBatch({ request: multiRequest, answers: emptyInputAnswers() }), 3_601)!;
    const generation = sendGeneration(store, prepared, 3_602, 3_000);
    const card = generation[0]!;
    assert.deepEqual(store.applyEvent(event(card.messageId!, {
      eventId: "legacy-first-select", inputId: tracked.inputId, requestRevision: multiRequest.revisionHash,
      questionId: "multi", action: "select", value: multiRequest.questions[0]!.choices[0]!.value, updateId: 1,
    }), 3_604), { kind: "changed", draftRevision: 1 });
    const oldAnswer = store.getRequest(tracked.inputId, multiRequest.revisionHash)!.answers.multi!;
    const toLegacy = (values: Readonly<Record<string, number>> | undefined): Record<string, number> | undefined => {
      if (!values) return undefined;
      return Object.fromEntries(Object.entries(values).map(([key, value]) => {
        const index = Number(key.slice(1));
        return [multiRequest.questions[0]!.choices[index]!.value, value];
      }));
    };
    const legacyAnswer = {
      ...oldAnswer,
      optionDraftRevisions: toLegacy(oldAnswer.optionDraftRevisions),
      optionUpdateIds: toLegacy(oldAnswer.optionUpdateIds),
      optionUpdateEpochs: toLegacy(oldAnswer.optionUpdateEpochs),
    } as Record<string, unknown>;
    delete legacyAnswer.optionOrderVersion;
    const databasePath = join(directory, "telegram-input.sqlite3");
    store.close();
    const database = new DatabaseSync(databasePath);
    database.prepare(`UPDATE input_requests SET answers_json=?,answer_order_version=0
      WHERE input_id=? AND request_revision=?`).run(
      JSON.stringify({ multi: legacyAnswer }), tracked.inputId, multiRequest.revisionHash,
    );
    database.close();
    store = makeInputStore(directory);
    const migrated = store.getRequest(tracked.inputId, multiRequest.revisionHash)!;
    assert.equal(migrated.answers.multi?.optionOrderVersion, 1);
    assert.deepEqual(migrated.answers.multi?.optionUpdateIds, { c0: 1 });
    assert.deepEqual(store.applyEvent(event(card.messageId!, {
      eventId: "legacy-second-select", inputId: tracked.inputId, requestRevision: multiRequest.revisionHash,
      questionId: "multi", action: "select", value: "b", updateId: 2,
    }), 3_610), { kind: "changed", draftRevision: 2 });
    assert.deepEqual(store.getRequest(tracked.inputId, multiRequest.revisionHash)?.answers.multi?.value,
      [multiRequest.questions[0]!.choices[0]!.value, "b"]);
  } finally {
    try { store.close(); } catch { /* the previous store may have been closed before a restart */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("known send rejection retries with the original key after bounded backoff", async () => {
  await withStore(async (store) => {
    const tracked = store.upsertRequest("env-1", request, 7_000);
    const generation = store.ensureGeneration(
      tracked.inputId, request.revisionHash, 0, renderInputBatch({ request, answers: emptyInputAnswers() }), 7_001,
    )!;
    const message = generation[0]!;
    assert.equal(store.beginMessageSend(message.deliveryKey, 7_002), true);
    assert.equal(store.recordMessageRejected(message.deliveryKey, "telegram_rejected", 7_003, 30_000), true);
    const rejected = store.messagesForRequest(tracked.inputId, request.revisionHash)[0]!;
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.sendRetryAt, 37_003);
    assert.equal(store.dueMessages(37_002).some((item) => item.deliveryKey === message.deliveryKey), false);
    assert.equal(store.beginMessageSend(message.deliveryKey, 37_002), false);
    assert.equal(store.dueMessages(37_003).some((item) => item.deliveryKey === message.deliveryKey), true);
    assert.equal(store.beginMessageSend(message.deliveryKey, 37_003), true);
    assert.equal(store.messagesForRequest(tracked.inputId, request.revisionHash)[0]?.deliveryKey, message.deliveryKey);
  });
});

test("known delete rejection retries safely before expiry while unknown deletes remain reconcile-only", async () => {
  await withStore(async (store) => {
    const tracked = prepareSentGeneration(store, 8_000);
    store.setRequestTerminal(tracked.inputId, request.revisionHash, 8_010);
    store.beginRetirement(tracked.inputId, request.revisionHash, "input-retire-delete-retry", 8_011);
    store.recordRetirement(tracked.inputId, request.revisionHash, "sent", 8_012);
    const message = store.dueCleanupMessages(8_013)[0]!;
    assert.equal(store.beginMessageDeletion(message.deliveryKey, 8_014), true);
    assert.equal(store.recordMessageDeleteRejected(message.deliveryKey, "telegram_rejected", 8_015, 30_000), true);
    const rejected = store.messagesForRequest(tracked.inputId, request.revisionHash)
      .find((item) => item.deliveryKey === message.deliveryKey)!;
    assert.equal(rejected.cleanupState, "pending");
    assert.equal(rejected.deleteRetryAt, 38_015);
    assert.equal(store.dueCleanupMessages(38_014).some((item) => item.deliveryKey === message.deliveryKey), false);
    assert.equal(store.dueCleanupMessages(38_015).some((item) => item.deliveryKey === message.deliveryKey), true);
    assert.equal(store.beginMessageDeletion(message.deliveryKey, 38_015), true);
    assert.equal(store.recordMessageDeleteUnknown(message.deliveryKey, "timeout", 38_016), true);
    assert.equal(store.beginMessageDeletion(message.deliveryKey, 38_017), false);
    assert.equal(store.dueCleanupMessages(38_017).some((item) => item.deliveryKey === message.deliveryKey), true);
  });
});

test("terminal payload compaction preserves an exact durable stale-request tombstone", async () => {
  await withStore(async (store) => {
    const tracked = prepareSentGeneration(store, 9_000);
    store.setRequestTerminal(tracked.inputId, request.revisionHash, 9_010);
    store.beginRetirement(tracked.inputId, request.revisionHash, "input-retire-compact", 9_011);
    store.recordRetirement(tracked.inputId, request.revisionHash, "sent", 9_012);
    for (const message of store.dueCleanupMessages(9_013)) {
      assert.equal(store.beginMessageDeletion(message.deliveryKey, 9_014), true);
      assert.equal(store.recordMessageDeleted(message.deliveryKey, 9_015), true);
    }
    assert.equal(store.getRequest(tracked.inputId, request.revisionHash), null);
    assert.equal(store.messagesForRequest(tracked.inputId, request.revisionHash).length, 0);
    assert.equal(store.isTombstoned(tracked.inputId, request.revisionHash), true);
    assert.equal(store.stats().capacity.activeRequestPayloads, 0);
    assert.equal(store.stats().capacity.requestTombstones, 1);
    assert.throws(() => store.upsertRequest("env-1", request, 9_016), /permanently retired/u);
    const newer = store.upsertRequest("env-1", { ...request, revisionHash: "revision-2" }, 9_017);
    assert.equal(newer.requestRevision, "revision-2");
  });
});

test("restart turns interrupted sends and deletions into reconciliation-only uncertainty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-recovery-"));
  let store = makeInputStore(directory);
  try {
    const tracked = store.upsertRequest("env-1", request, 5_000);
    const generation = store.ensureGeneration(
      tracked.inputId, request.revisionHash, 0, renderInputBatch({ request, answers: emptyInputAnswers() }), 5_001,
    )!;
    store.beginMessageSend(generation[0]!.deliveryKey, 5_002);
    store.beginMessageSend(generation[1]!.deliveryKey, 5_004);
    store.setRequestTerminal(tracked.inputId, request.revisionHash, 5_005);
    const retireKey = "input-retire-key";
    store.beginRetirement(tracked.inputId, request.revisionHash, retireKey, 5_006);
    store.close();
    store = makeInputStore(directory);
    const recovered = store.messagesForRequest(tracked.inputId, request.revisionHash);
    assert.equal(recovered[0]?.state, "unknown");
    assert.equal(recovered[0]?.cleanupState, "waiting");
    assert.equal(recovered[1]?.state, "unknown");
    assert.equal(recovered[1]?.cleanupState, "waiting");
    const requestAfterRestart = store.getRequest(tracked.inputId, request.revisionHash)!;
    assert.equal(requestAfterRestart.retirementState, "unknown");
  } finally {
    try { store.close(); } catch { /* store may already be closed */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup obligations persist, reconcile unknown deletes, and stop before Telegram's deletion window", async () => {
  await withStore(async (store) => {
    const tracked = prepareSentGeneration(store, 10_000);
    store.invalidateRequest(tracked.inputId, request.revisionHash, 10_010);
    const key = "input-retire-cleanup";
    store.beginRetirement(tracked.inputId, request.revisionHash, key, 10_011);
    store.recordRetirement(tracked.inputId, request.revisionHash, "sent", 10_012);
    const pending = store.dueCleanupMessages(10_013);
    assert.equal(pending.length, 2);
    assert.equal(store.beginMessageDeletion(pending[0]!.deliveryKey, 10_014), true);
    store.recordMessageDeleteUnknown(pending[0]!.deliveryKey, "timeout", 10_015);
    assert.equal(store.beginMessageDeletion(pending[0]!.deliveryKey, 10_016), false);
    assert.equal(store.recordMessageDeleted(pending[0]!.deliveryKey, 10_017), true);
    const old = store.messagesForRequest(tracked.inputId, request.revisionHash).find((message) =>
      message.deliveryKey !== pending[0]?.deliveryKey)!
    const late = old.deleteWindowAt + INPUT_DELETE_MAX_AGE_MS + 1;
    const due = store.dueCleanupMessages(late);
    assert.equal(due.some((message) => message.deliveryKey === old.deliveryKey), false);
    assert.equal(store.messagesForRequest(tracked.inputId, request.revisionHash).find((message) => message.deliveryKey === old.deliveryKey)?.cleanupState, "expired");
  });
});

test("unknown send becomes a cleanup obligation when its late Telegram id is recovered", async () => {
  await withStore(async (store) => {
    const tracked = store.upsertRequest("env-1", request, 20_000);
    const generation = store.ensureGeneration(
      tracked.inputId, request.revisionHash, 0, renderInputBatch({ request, answers: emptyInputAnswers() }), 20_001,
    )!;
    const message = generation[0]!;
    store.beginMessageSend(message.deliveryKey, 20_002);
    store.recordMessageUnknown(message.deliveryKey, "timeout", 20_003);
    store.setRequestTerminal(tracked.inputId, request.revisionHash, 20_004);
    store.beginRetirement(tracked.inputId, request.revisionHash, "input-retire-late", 20_005);
    store.recordRetirement(tracked.inputId, request.revisionHash, "sent", 20_006);
    assert.equal(store.messagesForRequest(tracked.inputId, request.revisionHash)[0]?.cleanupState, "waiting");
    assert.equal(store.recordMessageSent(message.deliveryKey, 987, 20_007), true);
    const recovered = store.messagesForRequest(tracked.inputId, request.revisionHash)[0]!;
    assert.equal(recovered.messageId, 987);
    assert.equal(recovered.cleanupState, "pending");
    assert.ok(recovered.cleanupKey);
  });
});

test("only old unknown sends with confirmed terminal retirement enter unconfirmed history", async () => {
  await withStore((store, directory) => {
    const base = 30_000;
    const later = base + INPUT_CLEANUP_UNCERTAINTY_TTL_MS + 1;
    const addUnknown = (requestId: string, createdAt: number) => {
      const nativeRequest = { ...request, requestId };
      const tracked = store.upsertRequest("env-1", nativeRequest, createdAt);
      const messages = store.ensureGeneration(
        tracked.inputId,
        nativeRequest.revisionHash,
        0,
        renderInputBatch({ request: nativeRequest, answers: emptyInputAnswers() }),
        createdAt + 1,
      )!;
      const message = messages[0]!;
      store.beginMessageSend(message.deliveryKey, createdAt + 2);
      store.recordMessageUnknown(message.deliveryKey, "invalid_response", createdAt + 3);
      return { tracked, message };
    };
    const retire = (tracked: ReturnType<typeof store.upsertRequest>, state: "sent" | "unknown", at: number) => {
      store.setRequestTerminal(tracked.inputId, tracked.requestRevision, at);
      store.beginRetirement(tracked.inputId, tracked.requestRevision, `retire-${tracked.requestId}`, at + 1);
      store.recordRetirement(tracked.inputId, tracked.requestRevision, state, at + 2);
    };

    const active = addUnknown("active", base);
    const uncertainRetirement = addUnknown("uncertain-retirement", base);
    retire(uncertainRetirement.tracked, "unknown", base + 4);
    const youngCreatedAt = later - INPUT_CLEANUP_UNCERTAINTY_TTL_MS + 1;
    const young = addUnknown("young", youngCreatedAt);
    retire(young.tracked, "sent", youngCreatedAt + 4);
    const expired = addUnknown("expired", base);
    retire(expired.tracked, "sent", base + 4);

    store.dueCleanupMessages(later);

    const activeAfter = store.messagesForRequest(active.tracked.inputId, active.tracked.requestRevision)[0]!;
    const uncertainRetirementAfter = store.messagesForRequest(
      uncertainRetirement.tracked.inputId,
      uncertainRetirement.tracked.requestRevision,
    )[0]!;
    const youngAfter = store.messagesForRequest(young.tracked.inputId, young.tracked.requestRevision)[0]!;
    const expiredAfter = store.messagesForRequest(expired.tracked.inputId, expired.tracked.requestRevision)[0]!;
    assert.equal(activeAfter.state, "unknown");
    assert.equal(activeAfter.cleanupState, "none");
    assert.equal(uncertainRetirementAfter.state, "unknown");
    assert.equal(store.getRequest(
      uncertainRetirement.tracked.inputId,
      uncertainRetirement.tracked.requestRevision,
    )?.retirementState, "unknown");
    assert.equal(uncertainRetirementAfter.cleanupState, "waiting");
    assert.equal(youngAfter.state, "unknown");
    assert.equal(youngAfter.cleanupState, "waiting");
    assert.equal(expiredAfter.state, "unknown");
    assert.equal(expiredAfter.error, "invalid_response");
    assert.equal(expiredAfter.messageId, null);
    assert.equal(expiredAfter.deliveryKey, expired.message.deliveryKey);
    assert.equal(expiredAfter.cleanupState, "expired");
    assert.equal(expiredAfter.cleanupError, "send_unconfirmed_expired");
    const stats = store.stats();
    assert.equal(stats.requests, 4);
    assert.equal(stats.pendingCleanup, 2);
    assert.equal(stats.uncertain, 4);

    const db = new DatabaseSync(join(directory, "telegram-input.sqlite3"), { readOnly: true });
    try {
      const history = db.prepare("SELECT * FROM input_cleanup_history WHERE delivery_key=?")
        .get(expired.message.deliveryKey)!;
      assert.equal(history.state, "expired");
      assert.equal(history.reason, "send_unconfirmed_expired");
      assert.equal(history.delivery_key, expired.message.deliveryKey);
      assert.equal(history.cleanup_key, null);
      assert.equal(history.message_id, null);
    } finally { db.close(); }
  });
});

test("unconfirmed send classification survives history pruning and store reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-input-expired-send-"));
  let store = makeInputStore(directory);
  try {
    const createdAt = 50_000;
    const tracked = store.upsertRequest("env-1", request, createdAt);
    const messages = store.ensureGeneration(
      tracked.inputId,
      tracked.requestRevision,
      0,
      renderInputBatch({ request, answers: emptyInputAnswers() }),
      createdAt + 1,
    )!;
    const original = messages[0]!;
    store.beginMessageSend(original.deliveryKey, createdAt + 2);
    store.recordMessageUnknown(original.deliveryKey, "invalid_response", createdAt + 3);
    store.setRequestTerminal(tracked.inputId, tracked.requestRevision, createdAt + 4);
    store.beginRetirement(tracked.inputId, tracked.requestRevision, "retire-expired-history", createdAt + 5);
    store.recordRetirement(tracked.inputId, tracked.requestRevision, "sent", createdAt + 6);

    const expiredAt = createdAt + INPUT_CLEANUP_UNCERTAINTY_TTL_MS + 1;
    store.dueCleanupMessages(expiredAt);
    assert.equal(store.stats().uncertain, 0);
    assert.equal(store.stats().pendingCleanup, 0);

    store.dueCleanupMessages(expiredAt + 31 * 24 * 60 * 60 * 1_000);
    const db = new DatabaseSync(join(directory, "telegram-input.sqlite3"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT 1 FROM input_cleanup_history WHERE delivery_key=?")
        .get(original.deliveryKey), undefined);
    } finally { db.close(); }

    store.close();
    store = makeInputStore(directory);
    const reopened = store.messagesForRequest(tracked.inputId, tracked.requestRevision)
      .find((message) => message.deliveryKey === original.deliveryKey)!;
    assert.equal(reopened.state, "unknown");
    assert.equal(reopened.error, "invalid_response");
    assert.equal(reopened.deliveryKey, original.deliveryKey);
    assert.equal(reopened.messageId, null);
    assert.equal(reopened.cleanupState, "expired");
    assert.equal(reopened.cleanupError, "send_unconfirmed_expired");
    assert.equal(store.stats().uncertain, 0);
    assert.equal(store.stats().pendingCleanup, 0);
  } finally {
    try { store.close(); } catch { /* store may already be closed */ }
    await rm(directory, { recursive: true, force: true });
  }
});


test("expired deletion audit survives payload compaction without claiming success", async () => {
  await withStore((store, directory) => {
    const tracked = prepareSentGeneration(store, 1000);
    store.invalidateRequest(tracked.inputId, tracked.requestRevision, 2000);
    const message = store.dueCleanupMessages(2000)[0]!;
    store.beginMessageDeletion(message.deliveryKey, 2000);
    store.recordMessageDeleteUnknown(message.deliveryKey, "invalid_response", 2000);
    const later = 1000 + 24 * 60 * 60 * 1000 + 100;
    assert.equal(store.expireUnknownDeletion(message.deliveryKey, later), true);
    store.setRequestTerminal(tracked.inputId, tracked.requestRevision, later);
    store.beginRetirement(tracked.inputId, tracked.requestRevision, "retire", later);
    store.recordRetirement(tracked.inputId, tracked.requestRevision, "sent", later);
    store.dueCleanupMessages(later);
    const db = new DatabaseSync(join(directory, "telegram-input.sqlite3"), { readOnly: true });
    try {
      const history = db.prepare("SELECT * FROM input_cleanup_history WHERE delivery_key=?").get(message.deliveryKey)!;
      assert.equal(history.state, "expired");
      assert.equal(history.reason, "deletion_unconfirmed_expired");
      assert.equal(history.cleanup_key, message.cleanupKey);
      assert.equal(history.message_id, message.messageId);
    } finally { db.close(); }
  });
});
