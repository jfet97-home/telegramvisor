import {
  INPUT_MAX_MESSAGE_UTF16,
  isInputBatchComplete,
} from "./input-domain.js";
import type {
  InputAnswers,
  InputButton,
  InputPresentation,
  InputQuestion,
  NativeInputRequest,
  RenderedInputMessage,
} from "./input-domain.js";

const QUESTION_BLOCK_UNITS = 2_500;
const REVIEW_BLOCK_UNITS = 2_500;
const PAGE_TEXT_UNITS = 2_700;
const MAX_CHOICE_BUTTONS_PER_PAGE = 8;

const takePrefix = (value: string, maximum: number): string => {
  let result = "";
  let units = 0;
  for (const character of value) {
    if (units + character.length > maximum) break;
    result += character;
    units += character.length;
  }
  return result;
};

const splitText = (value: string, maximum: number): string[] => {
  const chunks: string[] = [];
  let chunk = "";
  let units = 0;
  for (const character of value) {
    if (units + character.length > maximum) {
      chunks.push(chunk);
      chunk = "";
      units = 0;
    }
    chunk += character;
    units += character.length;
  }
  if (chunk.length > 0 || chunks.length === 0) chunks.push(chunk);
  return chunks;
};

interface QuestionContentPage {
  readonly text: string;
  readonly choiceIndices: readonly number[];
}

const packPages = (pages: readonly QuestionContentPage[]): QuestionContentPage[] => {
  const packed: QuestionContentPage[] = [];
  for (const page of pages) {
    const previous = packed.at(-1);
    if (previous && previous.text.length + page.text.length + 2 <= PAGE_TEXT_UNITS &&
      previous.choiceIndices.length + page.choiceIndices.length <= MAX_CHOICE_BUTTONS_PER_PAGE) {
      packed[packed.length - 1] = {
        text: `${previous.text}\n\n${page.text}`,
        choiceIndices: [...previous.choiceIndices, ...page.choiceIndices],
      };
    } else packed.push(page);
  }
  return packed;
};

const questionPages = (question: InputQuestion): QuestionContentPage[] => {
  const pages: QuestionContentPage[] = [];
  const promptParts = splitText(question.prompt, QUESTION_BLOCK_UNITS);
  promptParts.forEach((part, index) => {
    pages.push({
      text: `Prompt${promptParts.length > 1 ? ` (part ${index + 1}/${promptParts.length})` : ""}:\n${part}`,
      choiceIndices: [],
    });
  });
  if (question.kind !== "free_text") {
    let pageText = "Options:\n";
    let choiceIndices: number[] = [];
    const flush = (): void => {
      if (pageText.length > "Options:\n".length) pages.push({ text: pageText.trimEnd(), choiceIndices });
      pageText = "Options:\n";
      choiceIndices = [];
    };
    question.choices.forEach((choice, index) => {
      const label = `Option ${index + 1}: ${choice.label}${choice.description ? `\nDescription: ${choice.description}` : ""}\n`;
      const parts = splitText(label, QUESTION_BLOCK_UNITS);
      parts.forEach((part, partIndex) => {
        const continued = parts.length > 1 ? `Option ${index + 1} (part ${partIndex + 1}/${parts.length}):\n` : "";
        const piece = `${continued}${part}\n`;
        const introducesChoice = partIndex === parts.length - 1;
        const nextChoices = introducesChoice ? [...choiceIndices, index] : choiceIndices;
        if (pageText.length + piece.length > PAGE_TEXT_UNITS || nextChoices.length > MAX_CHOICE_BUTTONS_PER_PAGE) flush();
        pageText += piece;
        if (introducesChoice) choiceIndices.push(index);
        if (pageText.length > PAGE_TEXT_UNITS) flush();
      });
    });
    flush();
  }
  if (pages.length === 0) pages.push({ text: "No question text was provided.", choiceIndices: [] });
  return pages;
};

const questionAnswerText = (question: InputQuestion, answer: InputAnswers[string] | undefined): string[] => {
  if (!answer) return [];
  if (answer.kind === "skipped") return ["Your current answer: Skipped"];
  if (answer.kind === "free_text" || answer.contributionId !== null) {
    const value = answer.kind === "multi_choice" ? answer.customText : answer.value;
    if (typeof value !== "string") return [];
    return splitText(value, QUESTION_BLOCK_UNITS)
      .map((part, index, parts) => `Your current text answer${parts.length > 1 ? ` (part ${index + 1}/${parts.length})` : ""}:\n${part}`);
  }
  if (answer.kind === "single_choice" && typeof answer.value === "string") {
    const choice = question.choices.find((item) => item.value === answer.value);
    const value = choice?.label ?? answer.value;
    return splitText(value, QUESTION_BLOCK_UNITS)
      .map((part, index, parts) => `Your current answer${parts.length > 1 ? ` (part ${index + 1}/${parts.length})` : ""}:\n${part}`);
  }
  if (answer.kind === "multi_choice" && Array.isArray(answer.value)) {
    return [`Your current selections: ${answer.value.length}. Selected choices have a check mark; open Review for the complete list.`];
  }
  return [];
};

const questionContentPages = (question: InputQuestion): QuestionContentPage[] =>
  packPages(questionPages(question));

const answerFooter = (question: InputQuestion, answer: InputAnswers[string] | undefined): string => {
  const summary = questionAnswerText(question, answer).join(" ").replace(/\s+/gu, " ");
  return summary.length > 130 ? `${takePrefix(summary, 96)}… (full answer in Review)` : summary;
};

const reviewBlocks = (request: NativeInputRequest, answers: InputAnswers): string[] => {
  const blocks: string[] = [];
  request.questions.forEach((question, index) => {
    const answer = answers[question.id];
    const answerText = (() => {
      if (!answer) return question.required ? "Missing required answer" : "No answer";
      if (answer.kind === "skipped") return "Skipped";
      if (answer.kind === "free_text") return typeof answer.value === "string" ? answer.value : "No answer";
      if (answer.kind === "single_choice") {
        if (typeof answer.value !== "string") return "No answer";
        if (answer.contributionId !== null) return answer.value;
        return question.choices.find((choice) => choice.value === answer.value)?.label ?? answer.value;
      }
      if (typeof answer.customText === "string" && answer.customText.length > 0) return answer.customText;
      if (Array.isArray(answer.value)) {
        const values = answer.value;
        const selected = question.choices.filter((choice) => values.includes(choice.value));
        return selected.length > 0 ? selected.map((choice) => choice.label).join("\n") : "No answer";
      }
      return "No answer";
    })();
    const answerParts = splitText(answerText, REVIEW_BLOCK_UNITS);
    const promptParts = splitText(question.prompt, REVIEW_BLOCK_UNITS);
    promptParts.forEach((part, partIndex) => {
      blocks.push(`Question ${index + 1} prompt${promptParts.length > 1 ? ` (part ${partIndex + 1}/${promptParts.length})` : ""}:\n${part}`);
    });
    answerParts.forEach((part, partIndex) => {
      blocks.push(`Question ${index + 1} answer${answerParts.length > 1 ? ` (part ${partIndex + 1}/${answerParts.length})` : ""}:\n${part}`);
    });
  });
  return packPages(blocks.map((text) => ({ text, choiceIndices: [] }))).map((page) => page.text);
};

export const initialInputPresentation = (): InputPresentation => ({
  kind: "question",
  questionIndex: 0,
  page: 0,
  focusQuestionId: null,
  focusId: null,
});

export const inputPresentationPageCount = (request: NativeInputRequest, answers: InputAnswers, kind: "question" | "review", questionIndex: number): number => {
  if (kind === "review") return reviewBlocks(request, answers).length;
  const question = request.questions[questionIndex];
  return question ? questionContentPages(question).length : 0;
};

export const normalizeInputPresentation = (
  request: NativeInputRequest,
  answers: InputAnswers,
  presentation: InputPresentation,
): InputPresentation => {
  if (request.questions.length === 0) return { ...initialInputPresentation(), kind: "review" };
  const questionIndex = Math.max(0, Math.min(request.questions.length - 1, presentation.questionIndex));
  const kind = presentation.kind;
  const count = inputPresentationPageCount(request, answers, kind, questionIndex);
  const focusQuestionId = kind === "question" && request.questions.some((question) => question.id === presentation.focusQuestionId)
    ? presentation.focusQuestionId
    : null;
  return {
    kind,
    questionIndex,
    page: Math.max(0, Math.min(Math.max(0, count - 1), presentation.page)),
    focusQuestionId,
    focusId: focusQuestionId !== null && typeof presentation.focusId === "string" &&
      presentation.focusId.length > 0 && presentation.focusId.length <= 128 ? presentation.focusId : null,
    ...(presentation.replyNotice === "not_saved" || presentation.replyNotice === "text_required"
      ? { replyNotice: presentation.replyNotice } : {}),
  };
};

export const parseInputNavigation = (
  request: NativeInputRequest,
  answers: InputAnswers,
  value: string,
): InputPresentation | null => {
  const question = /^question:(\d+):(\d+)$/u.exec(value);
  if (question) {
    const questionIndex = Number(question[1]);
    const page = Number(question[2]);
    if (!Number.isSafeInteger(questionIndex) || !Number.isSafeInteger(page) || questionIndex >= request.questions.length ||
      page >= inputPresentationPageCount(request, answers, "question", questionIndex)) return null;
    return { kind: "question", questionIndex, page, focusQuestionId: null };
  }
  const review = /^review:(\d+)$/u.exec(value);
  if (review) {
    const page = Number(review[1]);
    if (!Number.isSafeInteger(page) || page >= inputPresentationPageCount(request, answers, "review", 0)) return null;
    return { kind: "review", questionIndex: 0, page, focusQuestionId: null };
  }
  return null;
};

const selection = (question: InputQuestion, answer: InputAnswers[string] | undefined): Set<string> => {
  if (question.kind === "multi_choice" && Array.isArray(answer?.value)) return new Set(answer.value);
  if (question.kind === "single_choice" && typeof answer?.value === "string") return new Set([answer.value]);
  return new Set();
};

const displayTitle = (request: NativeInputRequest): string => request.displayTitle?.trim().length
  ? `Chat: ${takePrefix(request.displayTitle.trim(), 256)}\n`
  : "";

const focusText = (request: NativeInputRequest, presentation: InputPresentation): string => {
  if (presentation.kind !== "question" || !presentation.focusQuestionId ||
    request.questions[presentation.questionIndex]?.id !== presentation.focusQuestionId) return "";
  return "To type: swipe left or open this message’s menu and choose Reply, then send your answer.\n\n";
};

const makeButton = (label: string, action: InputButton["action"], value?: string): InputButton => ({
  label,
  action,
  ...(value === undefined ? {} : { value }),
});

const addQuestionNavigation = (
  buttons: InputButton[][],
  request: NativeInputRequest,
  presentation: InputPresentation,
  pageCount: number,
): void => {
  const previous = presentation.page > 0
    ? makeButton("← Previous details", "navigate", `question:${presentation.questionIndex}:${presentation.page - 1}`)
    : presentation.questionIndex > 0
      ? makeButton("← Previous question", "navigate", `question:${presentation.questionIndex - 1}:0`)
      : null;
  const next = presentation.page + 1 < pageCount
    ? makeButton("More details →", "navigate", `question:${presentation.questionIndex}:${presentation.page + 1}`)
    : presentation.questionIndex + 1 < request.questions.length
      ? makeButton("Next question →", "navigate", `question:${presentation.questionIndex + 1}:0`)
      : null;
  if (previous || next) buttons.push([...(previous ? [previous] : []), ...(next ? [next] : [])]);
};

export const renderInputCard = (args: {
  readonly request: NativeInputRequest;
  readonly answers: InputAnswers;
  readonly presentation: InputPresentation;
  readonly draftRevision: number;
  readonly presentationRevision: number;
  readonly submissionRejected?: boolean;
  readonly submissionUncertain?: boolean;
}): RenderedInputMessage => {
  const { request, answers } = args;
  const presentation = normalizeInputPresentation(request, answers, args.presentation);
  const title = displayTitle(request);
  const currentQuestion = request.questions[presentation.questionIndex];
  const uncertain = args.submissionUncertain === true;
  const rejected = args.submissionRejected === true;
  let text: string;
  let questionId: string | null;
  const buttons: InputButton[][] = [];

  if (presentation.kind === "question" && currentQuestion) {
    questionId = currentQuestion.id;
    const answer = answers[currentQuestion.id];
    const pages = questionContentPages(currentQuestion);
    const page = pages[presentation.page] ?? pages[0]!;
    const header = `${title}Question ${presentation.questionIndex + 1} of ${request.questions.length}${pages.length > 1 ? ` · details ${presentation.page + 1}/${pages.length}` : ""}\n\n`;
    const focus = focusText(request, presentation);
    const textGuidance = currentQuestion.kind === "multi_choice"
      ? `Select all that apply.${currentQuestion.allowCustomAnswer ? " A text reply replaces your selections." : " Tap a selected answer to remove it."}`
      : currentQuestion.kind === "free_text" || currentQuestion.allowCustomAnswer
        ? answer?.contributionId ? "Reply again to replace your text answer."
          : currentQuestion.kind === "free_text" ? "Reply to this message with your answer."
            : "Choose an answer below, or reply to this message with your own."
        : "Choose an answer below. Tap a different answer to change it.";
    const footer = answerFooter(currentQuestion, answer);
    const status = uncertain
      ? "\n\nT3 may have received this submission. The draft is frozen and will not be sent again. Check the T3 chat; this card closes when T3 confirms."
      : rejected
        ? "\n\nT3 rejected the last submission. Change an answer before submitting again."
        : "";
    text = `${header}${focus}${page.text}${footer ? `\n\n${footer}` : ""}\n\n${textGuidance}${status}`;

    if (!uncertain) {
      const selected = selection(currentQuestion, answer);
      for (const choiceIndex of page.choiceIndices) {
        const choice = currentQuestion.choices[choiceIndex]!;
        const isSelected = selected.has(choice.value);
        const action = currentQuestion.kind === "multi_choice" && isSelected ? "deselect" : "select";
        const label = (choice.label.split("\n")[0] ?? choice.label).replace(/\s+/gu, " ").trim();
        const shortLabel = label.length > 60 ? `${takePrefix(label, 59)}…` : label;
        buttons.push([makeButton(`${isSelected ? "✓ " : ""}${shortLabel || `Answer ${choiceIndex + 1}`}`, action, choice.value)]);
      }
      addQuestionNavigation(buttons, request, presentation, pages.length);
      buttons.push([makeButton("Review & send", "review", "review:0")]);
      if (answer) buttons.push([makeButton(answer.kind === "skipped" ? "Undo skip" : "Clear answer", "clear")]);
      if (!currentQuestion.required && answer?.kind !== "skipped") buttons.push([makeButton("Skip", "skip")]);
      if (currentQuestion.allowCustomAnswer || currentQuestion.kind === "free_text") {
        buttons.push([makeButton("How to type my answer?", "edit_text")]);
      }
    }
  } else {
    questionId = null;
    const blocks = reviewBlocks(request, answers);
    const pageCount = Math.max(1, blocks.length);
    const page = Math.min(presentation.page, pageCount - 1);
    const header = `${title}Check your answers${pageCount > 1 ? ` · page ${page + 1}/${pageCount}` : ""}\n\n`;
    const focus = focusText(request, presentation);
    const block = blocks[page] ?? "No questions were provided.";
    const complete = isInputBatchComplete(request.questions, answers);
    const completeness = complete
      ? uncertain || rejected ? "" : page === pageCount - 1 ? "\n\nTap Send answers when you are ready." : "\n\nContinue to the last review page to send your answers."
      : "\n\nRequired answers are missing. Change a question before submitting.";
    const status = uncertain
      ? "\n\nT3 may have received this submission. The draft is frozen and will not be sent again. Check the T3 chat; this card closes when T3 confirms."
      : rejected
        ? "\n\nT3 rejected the last submission. Change an answer before submitting again."
        : "";
    text = `${header}${focus}${block}${completeness}${status}\n\nReplies on Review aren’t saved. To change an answer, tap Edit N.`;
    if (!uncertain) {
      if (page > 0) buttons.push([makeButton("← Previous", "navigate", `review:${page - 1}`)]);
      if (page + 1 < pageCount) buttons.push([makeButton("Next →", "navigate", `review:${page + 1}`)]);
      request.questions.forEach((_question, index) => {
        if (index % 4 === 0) buttons.push([]);
        buttons.at(-1)!.push(makeButton(`Edit ${index + 1}`, "navigate", `question:${index}:0`));
      });
      if (complete && !rejected && page === pageCount - 1) buttons.push([makeButton("Send answers", "submit")]);
    }
  }

  if (presentation.replyNotice) {
    text += presentation.replyNotice === "text_required"
      ? "\n\nYour last reply wasn’t saved: this form accepts text only."
      : "\n\nYour last reply wasn’t saved. Open the question and Reply again.";
  }

  if (text.length > INPUT_MAX_MESSAGE_UTF16) {
    throw new Error("rendered Telegram input exceeds its message bound");
  }
  return {
    questionId,
    fragment: presentation.page,
    presentationRevision: args.presentationRevision,
    focusId: presentation.focusId ?? null,
    text,
    buttons,
  };
};
