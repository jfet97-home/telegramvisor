import assert from "node:assert/strict";
import test from "node:test";
import { emptyInputAnswers, normalizeInputRequest } from "../src/input-domain.js";
import type { InputAnswers, InputPresentation, NativeInputRequest } from "../src/input-domain.js";
import { inputPresentationPageCount, initialInputPresentation, renderInputCard } from "../src/input-ui.js";

const makeRequest = (questions: unknown[]): NativeInputRequest => normalizeInputRequest({
  threadId: "thread-ui",
  requestId: "request-ui",
  revisionHash: "revision-ui",
  capability: "question-response",
  terminal: false,
  terminalState: null,
  questions,
});

test("short questions show real choices immediately and the complete review fits one screen", () => {
  const request = makeRequest([{
    id: "first", prompt: "Ship this change?", kind: "single_choice", required: true,
    allowCustomAnswer: true, choices: [{ value: "yes", label: "Yes, ship it" }, { value: "no", label: "Keep working" }],
  }, {
    id: "second", prompt: "Use the new layout?", kind: "single_choice", required: true,
    allowCustomAnswer: false, choices: [{ value: "yes", label: "Yes" }],
  }]);
  const card = renderInputCard({ request, answers: {}, presentation: initialInputPresentation(), draftRevision: 0, presentationRevision: 1 });
  assert.equal(inputPresentationPageCount(request, {}, "question", 0), 1);
  assert.ok(card.text.includes("Ship this change?"));
  assert.deepEqual(card.buttons.flat().filter((button) => button.action === "select").map((button) => button.label), ["Yes, ship it", "Keep working"]);
  assert.ok(card.buttons.flat().some((button) => button.label === "Next question →"));
  const answers: InputAnswers = {
    first: { kind: "single_choice", value: "yes", contributionId: null, updateId: 1 },
    second: { kind: "single_choice", value: "yes", contributionId: null, updateId: 2 },
  };
  assert.equal(inputPresentationPageCount(request, answers, "question", 0), 1);
  assert.equal(inputPresentationPageCount(request, answers, "review", 0), 1);
  const review = renderInputCard({ request, answers, presentation: { ...initialInputPresentation(), kind: "review" }, draftRevision: 2, presentationRevision: 3 });
  assert.ok(review.text.includes("Ship this change?"));
  assert.ok(review.text.includes("Use the new layout?"));
  assert.ok(review.buttons.flat().some((button) => button.label === "Send answers"));
});

test("question paging preserves long prompts and all 80 choices in bounded one-card views", () => {
  const prompt = "Long prompt 😀 ".repeat(6_000);
  const choices = Array.from({ length: 80 }, (_value, index) => ({
    value: `native-value-${index + 1}`,
    label: `Choice ${index + 1} ${"L".repeat(index === 79 ? 12_000 : 80)}`,
    description: `Description ${index + 1}`,
  }));
  const request = makeRequest([{
    id: "large",
    prompt,
    kind: "multi_choice",
    required: true,
    allowCustomAnswer: false,
    choices,
  }]);
  const answers = emptyInputAnswers();
  const pages = inputPresentationPageCount(request, answers, "question", 0);
  assert.ok(pages > 40);
  const rendered = Array.from({ length: pages }, (_value, page) => renderInputCard({
    request,
    answers,
    presentation: { ...initialInputPresentation(), page },
    draftRevision: 0,
    presentationRevision: page,
  }));
  assert.ok(rendered.every((message) => message.text.length <= 3_960));
  const renderedText = rendered.map((message) => message.text).join("");
  assert.equal(renderedText.match(/😀/gu)?.length, 6_000);
  assert.equal(renderedText.match(/L/gu)?.length,
    6_000 + choices.reduce((total, choice) => total + (choice.label.match(/L/gu)?.length ?? 0), 0));
  assert.deepEqual(
    rendered.flatMap((message) => message.buttons.flat()).filter((button) => button.action === "select")
      .map((button) => button.value),
    choices.map((choice) => choice.value),
  );
});

test("answers leave the question pages stable and text focus does not claim an unsent draft", () => {
  const request = makeRequest([{
    id: "first", prompt: "P".repeat(2_000), kind: "single_choice", required: false,
    allowCustomAnswer: true, choices: [{ value: "yes", label: "Yes", description: "D".repeat(900) }],
  }]);
  const initial = initialInputPresentation();
  const before = renderInputCard({ request, answers: {}, presentation: initial, draftRevision: 0, presentationRevision: 0 });
  const selected: InputAnswers = { first: { kind: "single_choice", value: "yes", contributionId: null, updateId: 1 } };
  const after = renderInputCard({ request, answers: selected, presentation: initial, draftRevision: 1, presentationRevision: 1 });
  assert.equal(inputPresentationPageCount(request, {}, "question", 0), inputPresentationPageCount(request, selected, "question", 0));
  assert.deepEqual(before.buttons.flat().filter((button) => button.action === "select").map((button) => button.value),
    after.buttons.flat().filter((button) => button.action === "select").map((button) => button.value));
  const focused = renderInputCard({ request, answers: {}, presentation: { ...initial, focusQuestionId: "first", focusId: "exact" }, draftRevision: 0, presentationRevision: 2 });
  assert.match(focused.text, /choose Reply/u);
  assert.doesNotMatch(focused.text, /saved as a draft/u);
  const skipped = renderInputCard({ request, answers: { first: { kind: "skipped", value: null, contributionId: null, updateId: 2 } }, presentation: initial, draftRevision: 1, presentationRevision: 3 });
  assert.match(skipped.text, /Skipped/u);
  assert.ok(skipped.buttons.flat().some((button) => button.label === "Undo skip"));
  assert.ok(!skipped.buttons.flat().some((button) => button.action === "skip"));
});

test("review paging preserves the maximum Unicode answer and only shows Submit on its final page", () => {
  const value = "😀".repeat(2_048);
  const request = makeRequest([{
    id: "answer",
    prompt: "Provide the complete text",
    kind: "free_text",
    required: true,
    allowCustomAnswer: true,
    choices: [],
  }]);
  const answers: InputAnswers = {
    answer: {
      kind: "free_text",
      value,
      contributionId: "telegram-reply-1",
      updateId: 4,
    },
  };
  const pageCount = inputPresentationPageCount(request, answers, "review", 0);
  assert.ok(pageCount > 1);
  const rendered = Array.from({ length: pageCount }, (_value, page) => renderInputCard({
    request,
    answers,
    presentation: { kind: "review", questionIndex: 0, page, focusQuestionId: null },
    draftRevision: 1,
    presentationRevision: page + 1,
  }));
  assert.ok(rendered.every((message) => message.text.length <= 3_960));
  assert.equal(rendered.map((message) => message.text).join("").match(/😀/gu)?.length, 2_048);
  assert.equal(rendered.slice(0, -1).some((message) => message.buttons.flat().some((button) => button.action === "submit")), false);
  assert.equal(rendered.at(-1)?.buttons.flat().filter((button) => button.action === "submit").length, 1);

  const incomplete = renderInputCard({
    request,
    answers: emptyInputAnswers(),
    presentation: { kind: "review", questionIndex: 0, page: 0, focusQuestionId: null },
    draftRevision: 0,
    presentationRevision: 9,
  });
  assert.equal(incomplete.buttons.flat().some((button) => button.action === "submit"), false);
});

test("review change controls and text-focus instructions fit the same card", () => {
  const request = makeRequest([
    { id: "first", prompt: "First", kind: "free_text", required: true, allowCustomAnswer: true, choices: [] },
    ...Array.from({ length: 31 }, (_value, index) => ({
      id: `q${index + 2}`,
      prompt: `Question ${index + 2}`,
      kind: "single_choice",
      required: false,
      allowCustomAnswer: false,
      choices: [{ value: `value-${index}`, label: `Choice ${index}` }],
    })),
  ]);
  const review = renderInputCard({
    request,
    answers: emptyInputAnswers(),
    presentation: { kind: "review", questionIndex: 0, page: 0, focusQuestionId: "first", focusId: "focus-exact-q1" },
    draftRevision: 0,
    presentationRevision: 1,
  });
  assert.ok(review.text.length <= 3_960);
  assert.ok(review.buttons.flat().some((button) => button.label === "Edit 32"));
  assert.ok(review.text.includes("Replies on Review"));
  assert.equal(review.focusId, null);
  const question = renderInputCard({
    request,
    answers: emptyInputAnswers(),
    presentation: { kind: "question", questionIndex: 0, page: 0, focusQuestionId: null } satisfies InputPresentation,
    draftRevision: 0,
    presentationRevision: 2,
  });
  assert.ok(question.buttons.flat().some((button) => button.action === "edit_text"));
  assert.ok(question.text.includes("Reply to this message"));
  assert.equal(question.buttons.at(-1)?.[0]?.label, "How to type my answer?");
});
