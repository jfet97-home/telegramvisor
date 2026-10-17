import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyInputAnswers,
  inputDefinitionHash,
  isEligibleInputThread,
  isInputBatchComplete,
  makeInputId,
  nativeInputAnswers,
  normalizeInputRequest,
  reduceInputEvent,
  renderInputBatch,
} from "../src/input-domain.js";
import type { InputEvent, NativeInputRequest } from "../src/input-domain.js";

const mixedRequest: NativeInputRequest = {
  threadId: "thread-1",
  requestId: "request-1",
  revisionHash: "revision-1",
  capability: "question-response",
  terminal: false,
  terminalState: null,
  questions: [
    {
      id: "single",
      prompt: "Choose one — 🛰️",
      kind: "single_choice",
      required: true,
      allowCustomAnswer: true,
      choices: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }],
    },
    {
      id: "multi",
      prompt: "Choose any that apply",
      kind: "multi_choice",
      required: true,
      allowCustomAnswer: false,
      choices: [{ value: "one", label: "One" }, { value: "two", label: "Two" }],
    },
    {
      id: "notes",
      prompt: "Anything else?",
      kind: "free_text",
      required: false,
      allowCustomAnswer: true,
      choices: [],
    },
  ],
};

const event = (overrides: Partial<InputEvent> = {}): InputEvent => ({
  eventId: "event-1",
  updateId: 1,
  updateEpoch: 0,
  messageId: 100,
  inputId: "input-id",
  requestRevision: mixedRequest.revisionHash,
  draftRevision: 0,
  questionId: "single",
  action: "select",
  value: "red",
  ...overrides,
});

test("normalizes three supported question kinds and hashes the complete definition", () => {
  const normalized = normalizeInputRequest(mixedRequest);
  assert.deepEqual(normalized, mixedRequest);
  assert.notEqual(inputDefinitionHash(mixedRequest), inputDefinitionHash({
    ...mixedRequest,
    questions: mixedRequest.questions.map((question) => question.id === "single"
      ? { ...question, prompt: "Choose another" }
      : question),
  }));
  assert.equal(makeInputId("environment", "thread-1", "request-1"), makeInputId("environment", "thread-1", "request-1"));
  assert.notEqual(makeInputId("environment", "thread-1", "request-1"), makeInputId("other", "thread-1", "request-1"));
  const displayRequest = normalizeInputRequest({
    ...mixedRequest,
    displayTitle: "First title",
    questions: mixedRequest.questions.map((question) => question.id === "single"
      ? { ...question, choices: [{ value: "red", label: "Red", description: "Warm color" }] }
      : question),
  });
  assert.equal(displayRequest.questions[0]?.choices[0]?.description, "Warm color");
  assert.equal(inputDefinitionHash(displayRequest), inputDefinitionHash({ ...displayRequest, displayTitle: "Renamed chat" }));
});

test("missing native required semantics and unsupported question types fail closed", () => {
  const missingRequired = structuredClone(mixedRequest) as unknown as Record<string, unknown>;
  const questions = missingRequired.questions as Array<Record<string, unknown>>;
  delete questions[0]?.required;
  assert.throws(() => normalizeInputRequest(missingRequired));
  const unsupported = structuredClone(mixedRequest) as unknown as Record<string, unknown>;
  const unsupportedQuestions = unsupported.questions as Array<Record<string, unknown>>;
  if (unsupportedQuestions[0]) unsupportedQuestions[0].kind = "approval";
  assert.throws(() => normalizeInputRequest(unsupported));
  const missingCustomFlag = structuredClone(mixedRequest) as unknown as Record<string, unknown>;
  const customQuestions = missingCustomFlag.questions as Array<Record<string, unknown>>;
  if (customQuestions[0]) delete customQuestions[0].allowCustomAnswer;
  assert.equal(normalizeInputRequest(missingCustomFlag).questions[0]?.allowCustomAnswer, true);
});

test("native T3 anchors persist without changing the questionnaire definition hash", () => {
  const anchored = normalizeInputRequest({
    ...mixedRequest,
    nativeT3Anchor: {
      environmentId: "environment-1",
      itemId: "item-1",
      owner: {
        threadId: "thread-1",
        runId: "run-1",
        nodeId: "node-1",
        providerInstanceId: "codex",
        providerThreadId: null,
        providerTurnId: null,
      },
      rawRequest: { id: "request-1", nodeId: "node-1", providerTurnId: null, kind: "user_input", status: "pending" },
      rawTurnItem: {
        id: "item-1",
        threadId: "thread-1",
        runId: "run-1",
        nodeId: "node-1",
        type: "user_input_request",
        requestId: "request-1",
        questions: [],
      },
    },
  });

  assert.equal(anchored.nativeT3Anchor?.itemId, "item-1");
  assert.deepEqual(anchored.nativeT3Anchor?.owner, {
    threadId: "thread-1",
    runId: "run-1",
    nodeId: "node-1",
    providerInstanceId: "codex",
    providerThreadId: null,
    providerTurnId: null,
  });
  assert.equal(inputDefinitionHash(anchored), inputDefinitionHash(mixedRequest));
  const inconsistentOwner = structuredClone(anchored) as unknown as Record<string, unknown>;
  const inconsistentAnchor = inconsistentOwner.nativeT3Anchor as Record<string, unknown>;
  const inconsistentItem = inconsistentAnchor.rawTurnItem as Record<string, unknown>;
  inconsistentItem.runId = "another-run";
  assert.throws(() => normalizeInputRequest(inconsistentOwner));
  assert.throws(() => normalizeInputRequest({
    ...mixedRequest,
    nativeT3Anchor: {
      environmentId: "environment-1",
      itemId: "wrong-item",
      owner: { threadId: "thread-1", nodeId: "node-1" },
      rawRequest: { id: "request-1", nodeId: "node-1", providerTurnId: null, kind: "user_input" },
      rawTurnItem: { id: "item-1", threadId: "thread-1", requestId: "request-1", type: "user_input_request" },
    },
  }));
});

test("current router and active ordinary forks are eligible while delegated, archived, deleted, and approval chats are blocked", () => {
  assert.equal(isEligibleInputThread({ id: "router", currentRouter: true, active: false, kind: "main" }), true);
  assert.equal(isEligibleInputThread({ id: "fork", active: true, kind: "fork" }), true);
  assert.equal(isEligibleInputThread({ id: "delegated", active: true, delegated: true }), false);
  assert.equal(isEligibleInputThread({ id: "archived", active: true, archived: true }), false);
  assert.equal(isEligibleInputThread({ id: "deleted", active: true, deleted: true }), false);
  assert.equal(isEligibleInputThread({ id: "approval", active: true, approvalRequest: true }), false);
});

test("absolute choice updates are idempotent and reject stale render revisions", () => {
  const selected = reduceInputEvent({
    inputId: "input-id",
    request: mixedRequest,
    draftRevision: 0,
    answers: emptyInputAnswers(),
    event: event(),
  });
  assert.equal(selected.kind, "changed");
  if (selected.kind !== "changed") return;
  assert.equal(selected.draftRevision, 1);
  const duplicateSet = reduceInputEvent({
    inputId: "input-id",
    request: mixedRequest,
    draftRevision: 1,
    answers: selected.answers,
    event: event({ eventId: "event-2", draftRevision: 1, updateId: 2 }),
  });
  assert.equal(duplicateSet.kind, "unchanged");
  const oldRender = reduceInputEvent({
    inputId: "input-id",
    request: mixedRequest,
    draftRevision: 1,
    answers: selected.answers,
    event: event({ eventId: "event-3", draftRevision: 0, updateId: 3, value: "blue" }),
  });
  assert.deepEqual(oldRender, { kind: "ignored", reason: "stale_question" });
});

test("a repeated absolute set advances event ordering without creating a new draft", () => {
  const first = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(), event: event(),
  });
  assert.equal(first.kind, "changed");
  if (first.kind !== "changed") return;
  const repeat = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 1, answers: first.answers,
    event: event({ eventId: "newer-set", updateId: 3, draftRevision: 1 }),
  });
  assert.equal(repeat.kind, "unchanged");
  assert.equal(repeat.draftRevision, 1);
  assert.equal(repeat.answers.single?.updateId, 3);
  const delayed = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 1, answers: repeat.answers,
    event: event({ eventId: "delayed-set", updateId: 2, draftRevision: 1, value: "blue" }),
  });
  assert.deepEqual(delayed, { kind: "ignored", reason: "reordered_event" });
});

test("a repeated set from an older multi-choice card cannot undo a newer deselect", () => {
  const firstSelect = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({ questionId: "multi", action: "select", value: "one", updateId: 1 }),
  });
  assert.equal(firstSelect.kind, "changed");
  if (firstSelect.kind !== "changed") return;
  const deselect = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 1, answers: firstSelect.answers,
    event: event({ questionId: "multi", action: "deselect", value: "one", updateId: 2, draftRevision: 1 }),
  });
  assert.equal(deselect.kind, "changed");
  if (deselect.kind !== "changed") return;
  assert.deepEqual(deselect.answers.multi?.value, []);
  const staleSet = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 2, answers: deselect.answers,
    event: event({ questionId: "multi", action: "select", value: "one", updateId: 3, draftRevision: 0 }),
  });
  assert.deepEqual(staleSet, { kind: "ignored", reason: "stale_question" });
  assert.deepEqual(deselect.answers.multi?.value, []);
});

test("reset epochs accept fresh lower IDs while old and edited text ordering remains stable", () => {
  const first = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({
      eventId: "before-reset", updateId: 2_000_000_000, updateEpoch: 0, questionId: "notes",
      action: "answer", text: "Before reset", contributionId: "before-reset-message",
    }),
  });
  assert.equal(first.kind, "changed");
  if (first.kind !== "changed") return;

  const afterReset = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: first.draftRevision, answers: first.answers,
    event: event({
      eventId: "after-reset", updateId: 123, updateEpoch: 1, draftRevision: 1, questionId: "notes",
      action: "answer", text: "After reset", contributionId: "after-reset-message",
    }),
  });
  assert.equal(afterReset.kind, "changed");
  if (afterReset.kind !== "changed") return;
  assert.equal(afterReset.answers.notes?.value, "After reset");
  assert.equal(afterReset.answers.notes?.updateId, 123);
  assert.equal(afterReset.answers.notes?.updateEpoch, 1);

  const oldEpochReplay = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: afterReset.draftRevision, answers: afterReset.answers,
    event: event({
      eventId: "old-epoch-replay", updateId: 1_999_999_999, updateEpoch: 0,
      draftRevision: 2, questionId: "notes", action: "answer", text: "Stale replay",
      contributionId: "stale-message",
    }),
  });
  assert.deepEqual(oldEpochReplay, { kind: "ignored", reason: "reordered_event" });

  const edited = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: afterReset.draftRevision, answers: afterReset.answers,
    event: event({
      eventId: "newer-edit", updateId: 124, updateEpoch: 1, draftRevision: 2, questionId: "notes",
      action: "answer", text: "Corrected after reset", contributionId: "after-reset-message", edited: true,
    }),
  });
  assert.equal(edited.kind, "changed");
  if (edited.kind !== "changed") return;
  const olderEdit = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: edited.draftRevision, answers: edited.answers,
    event: event({
      eventId: "older-edit", updateId: 123, updateEpoch: 1, draftRevision: 3, questionId: "notes",
      action: "answer", text: "Older edit", contributionId: "after-reset-message", edited: true,
    }),
  });
  assert.deepEqual(olderEdit, { kind: "ignored", reason: "reordered_event" });
  assert.equal(edited.answers.notes?.value, "Corrected after reset");
});

test("multi-choice option order compares epochs before raw update IDs", () => {
  const first = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({ questionId: "multi", action: "select", value: "one", updateId: 2_000_000_000, updateEpoch: 0 }),
  });
  assert.equal(first.kind, "changed");
  if (first.kind !== "changed") return;
  const resetToggle = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: first.draftRevision, answers: first.answers,
    event: event({
      eventId: "reset-deselect", questionId: "multi", action: "deselect", value: "one",
      updateId: 123, updateEpoch: 1, draftRevision: 1,
    }),
  });
  assert.equal(resetToggle.kind, "changed");
  if (resetToggle.kind !== "changed") return;
  assert.deepEqual(resetToggle.answers.multi?.value, []);
  assert.deepEqual(resetToggle.answers.multi?.optionUpdateEpochs, { c0: 1 });
  const oldToggle = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: resetToggle.draftRevision, answers: resetToggle.answers,
    event: event({
      eventId: "old-epoch-select", questionId: "multi", action: "select", value: "one",
      updateId: 1_999_999_999, updateEpoch: 0, draftRevision: 2,
    }),
  });
  assert.deepEqual(oldToggle, { kind: "ignored", reason: "reordered_event" });
});

test("multi-select clicks from one keyboard merge across options and reject same-option stale updates", () => {
  const first = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({ questionId: "multi", action: "select", value: "one", updateId: 10 }),
  });
  assert.equal(first.kind, "changed");
  if (first.kind !== "changed") return;
  const second = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: first.draftRevision, answers: first.answers,
    event: event({ eventId: "select-two", questionId: "multi", action: "select", value: "two", updateId: 11, draftRevision: 0 }),
  });
  assert.equal(second.kind, "changed");
  if (second.kind !== "changed") return;
  assert.deepEqual(second.answers.multi?.value, ["one", "two"]);
  const oldSameOption = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: second.draftRevision, answers: second.answers,
    event: event({ eventId: "old-unset-one", questionId: "multi", action: "deselect", value: "one", updateId: 12, draftRevision: 0 }),
  });
  assert.deepEqual(oldSameOption, { kind: "ignored", reason: "stale_question" });
  const repeatedSet = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: second.draftRevision, answers: second.answers,
    event: event({ eventId: "repeat-set-one", questionId: "multi", action: "select", value: "one", updateId: 13, draftRevision: 0 }),
  });
  assert.equal(repeatedSet.kind, "unchanged");
  if (repeatedSet.kind === "unchanged") assert.deepEqual(repeatedSet.answers.multi?.value, ["one", "two"]);
});

test("a multi-choice text answer conflicts with old option controls", () => {
  const customRequest: NativeInputRequest = {
    ...mixedRequest,
    questions: mixedRequest.questions.map((question) => question.id === "multi"
      ? { ...question, allowCustomAnswer: true }
      : question),
  };
  const first = reduceInputEvent({
    inputId: "input-id", request: customRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({ questionId: "multi", action: "answer", text: "Other", contributionId: "text-reply" }),
  });
  assert.equal(first.kind, "changed");
  if (first.kind !== "changed") return;
  const staleOption = reduceInputEvent({
    inputId: "input-id", request: customRequest, draftRevision: first.draftRevision, answers: first.answers,
    event: event({ questionId: "multi", action: "select", value: "one", updateId: 2, draftRevision: 0 }),
  });
  assert.deepEqual(staleOption, { kind: "ignored", reason: "stale_question" });
});

test("edited older text contributions cannot replace the current contribution", () => {
  const initial = reduceInputEvent({
    inputId: "input-id",
    request: mixedRequest,
    draftRevision: 0,
    answers: emptyInputAnswers(),
    event: event({ action: "answer", questionId: "notes", text: "first", contributionId: "first-message" }),
  });
  assert.equal(initial.kind, "changed");
  if (initial.kind !== "changed") return;
  const current = reduceInputEvent({
    inputId: "input-id",
    request: mixedRequest,
    draftRevision: 1,
    answers: initial.answers,
    event: event({
      eventId: "event-2", updateId: 2, draftRevision: 1, action: "answer", questionId: "notes",
      text: "newer answer", contributionId: "new-message",
    }),
  });
  assert.equal(current.kind, "changed");
  if (current.kind !== "changed") return;
  const oldEdit = reduceInputEvent({
    inputId: "input-id",
    request: mixedRequest,
    draftRevision: 2,
    answers: current.answers,
    event: event({
      eventId: "event-3", updateId: 3, draftRevision: 2, action: "answer", questionId: "notes",
      text: "edited old answer", contributionId: "first-message", edited: true,
    }),
  });
  assert.deepEqual(oldEdit, { kind: "ignored", reason: "superseded_contribution" });
});

test("optional skip is explicit and native submit includes the complete required batch", () => {
  const single = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event(),
  });
  assert.equal(single.kind, "changed");
  if (single.kind !== "changed") return;
  const multi = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 1, answers: single.answers,
    event: event({ eventId: "event-2", updateId: 2, draftRevision: 1, questionId: "multi", value: "two" }),
  });
  assert.equal(multi.kind, "changed");
  if (multi.kind !== "changed") return;
  assert.equal(isInputBatchComplete(mixedRequest.questions, multi.answers), true);
  assert.deepEqual(nativeInputAnswers(mixedRequest.questions, multi.answers), { single: "red", multi: ["two"] });
  const skipped = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 2, answers: multi.answers,
    event: event({ eventId: "event-3", updateId: 3, draftRevision: 2, questionId: "notes", action: "skip" }),
  });
  assert.equal(skipped.kind, "changed");
  if (skipped.kind === "changed") {
    assert.deepEqual(nativeInputAnswers(mixedRequest.questions, skipped.answers), { single: "red", multi: ["two"], notes: null });
  }
  const requiredSkip = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({ questionId: "single", action: "skip" }),
  });
  assert.deepEqual(requiredSkip, { kind: "ignored", reason: "skip_not_allowed" });
});

test("native custom answers map to trimmed strings for single and multi-choice questions", () => {
  const customSingle = reduceInputEvent({
    inputId: "input-id",
    request: mixedRequest,
    draftRevision: 0,
    answers: emptyInputAnswers(),
    event: event({
      eventId: "custom-single", action: "answer", questionId: "single", text: "  Other single answer  ",
      contributionId: "custom-single-contribution",
    }),
  });
  assert.equal(customSingle.kind, "changed");
  if (customSingle.kind !== "changed") return;
  const selectMulti = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 1, answers: customSingle.answers,
    event: event({ eventId: "multi-choice", updateId: 2, draftRevision: 1, questionId: "multi", value: "one" }),
  });
  assert.equal(selectMulti.kind, "changed");
  if (selectMulti.kind !== "changed") return;
  assert.deepEqual(nativeInputAnswers(mixedRequest.questions, selectMulti.answers), {
    single: "Other single answer",
    multi: ["one"],
  });

  const customMultiRequest: NativeInputRequest = {
    ...mixedRequest,
    questions: mixedRequest.questions.map((question) => question.id === "multi"
      ? { ...question, allowCustomAnswer: true }
      : question),
  };
  const customMulti = reduceInputEvent({
    inputId: "input-id", request: customMultiRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({
      eventId: "custom-multi", action: "answer", questionId: "multi", text: "  Third option  ",
      contributionId: "custom-multi-contribution",
    }),
  });
  assert.equal(customMulti.kind, "changed");
  if (customMulti.kind !== "changed") return;
  assert.deepEqual(nativeInputAnswers(customMultiRequest.questions, {
    ...customMulti.answers,
    single: { kind: "single_choice", value: " Other single answer ", contributionId: "custom-single-contribution", updateId: 1 },
  }), { single: "Other single answer", multi: "Third option" });
  const selected = reduceInputEvent({
    inputId: "input-id", request: customMultiRequest, draftRevision: 1, answers: customMulti.answers,
    event: event({ eventId: "multi-select", updateId: 2, draftRevision: 1, questionId: "multi", value: "two" }),
  });
  assert.equal(selected.kind, "changed");
  if (selected.kind !== "changed") return;
  const single = reduceInputEvent({
    inputId: "input-id", request: customMultiRequest, draftRevision: 2, answers: selected.answers,
    event: event({ eventId: "single-select", updateId: 3, draftRevision: 2, questionId: "single", value: "red" }),
  });
  assert.equal(single.kind, "changed");
  if (single.kind !== "changed") return;
  assert.deepEqual(nativeInputAnswers(customMultiRequest.questions, single.answers), {
    single: "red",
    multi: ["two"],
  });
  assert.ok(renderInputBatch({ request: mixedRequest, answers: emptyInputAnswers() })[0]?.text.includes("custom answer"));
});

test("native custom answers remain disabled when the native flag is false", () => {
  const result = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 0, answers: emptyInputAnswers(),
    event: event({
      eventId: "disallowed-custom", action: "answer", questionId: "multi", text: "Other",
      contributionId: "disallowed-contribution",
    }),
  });
  assert.deepEqual(result, { kind: "ignored", reason: "invalid_text_answer" });
});

test("question text is preserved across Unicode-safe Telegram fragments below 4000 UTF-16 units", () => {
  const longRequest: NativeInputRequest = {
    ...mixedRequest,
    questions: [{
      id: "long",
      prompt: `Start ${"x".repeat(9_000)} 📦 End`,
      kind: "free_text",
      required: true,
      allowCustomAnswer: true,
      choices: [],
    }],
  };
  const messages = renderInputBatch({ request: longRequest, answers: emptyInputAnswers() });
  assert.ok(messages.length > 2);
  assert.ok(messages.every((message) => message.text.length <= 4_000));
  const chunks = messages.map((message) => message.text.slice(message.text.indexOf("\n\n") + 2));
  assert.equal(chunks.join(""), `${longRequest.questions[0]!.prompt}\n\nReply to this message with your answer as text.\n\nPhotos, files and voice messages do not submit questionnaire answers.`);
  assert.ok(messages.every((message) => !/[\uD800-\uDBFF]$/u.test(message.text)));
});

test("display title stays outside the semantic hash and appears with choice descriptions and answer drafts", () => {
  const request: NativeInputRequest = {
    ...mixedRequest,
    displayTitle: "Planning chat",
    questions: mixedRequest.questions.map((question) => question.id === "single"
      ? { ...question, choices: [{ value: "red", label: "Red", description: "Warm color" }, { value: "blue", label: "Blue" }] }
      : question),
  };
  const renamed = { ...request, displayTitle: "Renamed planning chat" };
  assert.equal(inputDefinitionHash(request), inputDefinitionHash(renamed));
  const customMultiRequest: NativeInputRequest = {
    ...request,
    questions: request.questions.map((question) => question.id === "multi"
      ? { ...question, allowCustomAnswer: true }
      : question),
  };
  const messages = renderInputBatch({
    request: customMultiRequest,
  answers: {
      multi: {
        kind: "multi_choice", value: [], customText: "Third option", contributionId: "custom-reply",
        updateId: 1, updateEpoch: 0, changedAtDraftRevision: 1,
      },
    },
  });
  assert.ok(messages[0]?.text.includes("Chat: Planning chat"));
  assert.ok(messages[0]?.text.includes("Red — Warm color"));
  assert.ok(messages.find((message) => message.questionId === "multi")?.text.includes("Your current custom answer:\nThird option"));
});

test("multipart fragments repeat a bounded chat title and uncertainty freezes controls while preserving the draft", () => {
  const request: NativeInputRequest = {
    ...mixedRequest,
    displayTitle: "A".repeat(512),
    questions: [{
      id: "long", prompt: `Start ${"x".repeat(9_000)} End`, kind: "free_text", required: true,
      allowCustomAnswer: true, choices: [],
    }],
  };
  const rendered = renderInputBatch({
    request,
    answers: { long: { kind: "free_text", value: "Saved draft", contributionId: "draft", updateId: 1, updateEpoch: 0 } },
    submissionUncertain: true,
  });
  assert.ok(rendered.length > 2);
  assert.ok(rendered.every((message) => message.text.length <= 4_000));
  assert.ok(rendered.every((message) => message.text.includes(`Chat: ${"A".repeat(256)}`)));
  assert.ok(rendered.every((message) => message.buttons.length === 0));
  assert.ok(rendered.some((message) => message.text.includes("Your current answer:\nSaved draft")));
  assert.match(rendered.at(-1)?.text ?? "", /Submission status[\s\S]*will not be sent again/u);
  assert.equal(rendered.at(-1)?.questionId, null);
});

test("submit is an explicit control tied to the exact displayed draft revision", () => {
  const completeAnswers = {
    single: { kind: "single_choice" as const, value: "red", contributionId: null, updateId: 1, updateEpoch: 0 },
    multi: { kind: "multi_choice" as const, value: ["two"], contributionId: null, updateId: 2, updateEpoch: 0 },
  };
  const rendered = renderInputBatch({ request: mixedRequest, answers: completeAnswers });
  const submit = rendered.at(-1);
  assert.equal(submit?.questionId, null);
  assert.deepEqual(submit?.buttons, [[{ label: "Submit", action: "submit" }]]);
  const result = reduceInputEvent({
    inputId: "input-id", request: mixedRequest, draftRevision: 7, answers: completeAnswers,
    event: event({ questionId: null, action: "submit", draftRevision: 6 }),
  });
  assert.deepEqual(result, { kind: "ignored", reason: "stale_draft" });
});
