import { createHash } from "node:crypto";

export const INPUT_MAX_MESSAGE_UTF16 = 3_960;
export const INPUT_MAX_QUESTIONS = 32;
export const INPUT_MAX_CHOICES = 80;
export const INPUT_MAX_REQUEST_JSON_BYTES = 256 * 1024;
export const INPUT_MAX_ANSWER_UTF16 = 4_096;
export const INPUT_MAX_DISPLAY_TITLE_UTF16 = 512;
export const INPUT_MAX_ANSWERS_JSON_BYTES = 2 * 1024 * 1024;

export type InputQuestionKind = "single_choice" | "multi_choice" | "free_text";
export type InputAction = "answer" | "select" | "deselect" | "skip" | "submit" | "navigate" | "edit_text" | "review" | "clear" | "stale";
export type InputSubmissionState = "none" | "intent" | "accepted" | "rejected" | "unknown";

export interface InputChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface InputQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly kind: InputQuestionKind;
  readonly required: boolean;
  readonly allowCustomAnswer: boolean;
  readonly choices: readonly InputChoice[];
}

export interface NativeInputT3Anchor {
  readonly environmentId: string;
  readonly itemId: string;
  readonly owner: {
    readonly threadId: string;
    readonly runId: string | null;
    readonly nodeId: string;
    readonly providerInstanceId: string | null;
    readonly providerThreadId: string | null;
    readonly providerTurnId: string | null;
  };
  readonly rawRequest: Readonly<Record<string, unknown>>;
  readonly rawTurnItem: Readonly<Record<string, unknown>>;
}

/** Normalized native request shape consumed by the coordinator. */
export interface NativeInputRequest {
  readonly threadId: string;
  readonly requestId: string;
  readonly revisionHash: string;
  readonly capability: string;
  readonly displayTitle?: string;
  readonly terminal: boolean;
  readonly terminalState: string | null;
  readonly requestKind?: "question" | "approval";
  readonly questions: readonly InputQuestion[];
  readonly nativeT3Anchor?: NativeInputT3Anchor;
}

export interface InputThread {
  readonly id: string;
  readonly rootThreadId?: string;
  readonly active?: boolean;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly delegated?: boolean;
  readonly approvalRequest?: boolean;
  readonly currentRouter?: boolean;
  readonly kind?: string;
  readonly relationshipToParent?: string | null;
}

export interface InputAnswerRecord {
  readonly kind: InputQuestionKind | "skipped";
  readonly value: string | readonly string[] | null;
  readonly contributionId: string | null;
  readonly updateId: number;
  readonly updateEpoch?: number;
  readonly customText?: string;
  readonly changedAtDraftRevision?: number;
  readonly nonOptionChangedAtDraftRevision?: number;
  readonly optionDraftRevisions?: Readonly<Record<string, number>>;
  readonly optionUpdateIds?: Readonly<Record<string, number>>;
  readonly optionUpdateEpochs?: Readonly<Record<string, number>>;
  readonly optionOrderVersion?: 1;
}

export type InputAnswers = Readonly<Record<string, InputAnswerRecord>>;

export interface InputAnswerTombstone {
  readonly updateId: number;
  readonly updateEpoch: number;
  readonly draftRevision: number;
  readonly presentationRevision: number;
  readonly contributionId?: string;
}

export type InputAnswerTombstones = Readonly<Record<string, InputAnswerTombstone>>;

export interface InputEvent {
  readonly eventId: string;
  readonly updateId: number;
  readonly updateEpoch?: number;
  readonly messageId: number;
  readonly inputId: string;
  readonly requestRevision: string;
  readonly draftRevision: number;
  readonly questionId: string | null;
  readonly action: InputAction;
  readonly value?: string;
  readonly text?: string;
  readonly contributionId?: string;
  readonly edited?: boolean;
  readonly deliveryKey?: string;
  readonly presentationRevision?: number;
  readonly focusId?: string;
  readonly focusPresentationRevision?: number;
}

export interface InputButton {
  readonly label: string;
  readonly action: "select" | "deselect" | "skip" | "submit" | "navigate" | "edit_text" | "review" | "clear";
  readonly value?: string;
}

export interface InputPresentation {
  readonly replyNotice?: "not_saved" | "text_required";
  readonly kind: "question" | "review";
  readonly questionIndex: number;
  readonly page: number;
  readonly focusQuestionId: string | null;
  readonly focusId?: string | null;
}

export interface RenderedInputMessage {
  readonly questionId: string | null;
  readonly fragment: number;
  readonly presentationRevision?: number;
  readonly focusId?: string | null;
  readonly text: string;
  readonly buttons: readonly (readonly InputButton[])[];
}

export type InputEventReduction =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "submit" }
  | { readonly kind: "unchanged"; readonly answers: InputAnswers; readonly draftRevision: number }
  | { readonly kind: "changed"; readonly answers: InputAnswers; readonly draftRevision: number };

export class InputDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputDomainError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const nullableString = (value: unknown): value is string | null =>
  value === null || isNonEmptyString(value);

const normalizeNativeT3Anchor = (value: unknown, threadId: string, requestId: string): NativeInputT3Anchor | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isNonEmptyString(value.environmentId) || !isNonEmptyString(value.itemId) ||
    !isRecord(value.owner) || !isRecord(value.rawRequest) || !isRecord(value.rawTurnItem)) {
    throw new InputDomainError("native T3 input anchor is malformed");
  }
  const owner = value.owner;
  if (!isNonEmptyString(owner.threadId) || !isNonEmptyString(owner.nodeId) ||
    !nullableString(owner.runId) || !nullableString(owner.providerInstanceId) ||
    !nullableString(owner.providerThreadId) || !nullableString(owner.providerTurnId) ||
    owner.threadId !== threadId || value.rawRequest.id !== requestId ||
    value.rawRequest.kind !== "user_input" || value.rawRequest.nodeId !== owner.nodeId ||
    value.rawRequest.providerTurnId !== owner.providerTurnId ||
    value.rawTurnItem.id !== value.itemId || value.rawTurnItem.threadId !== threadId ||
    value.rawTurnItem.nodeId !== owner.nodeId ||
    (value.rawTurnItem.runId !== undefined && value.rawTurnItem.runId !== owner.runId) ||
    value.rawTurnItem.requestId !== requestId || value.rawTurnItem.type !== "user_input_request") {
    throw new InputDomainError("native T3 input anchor ownership is inconsistent");
  }
  return {
    environmentId: value.environmentId,
    itemId: value.itemId,
    owner: {
      threadId: owner.threadId,
      runId: owner.runId,
      nodeId: owner.nodeId,
      providerInstanceId: owner.providerInstanceId,
      providerThreadId: owner.providerThreadId,
      providerTurnId: owner.providerTurnId,
    },
    rawRequest: { ...value.rawRequest },
    rawTurnItem: { ...value.rawTurnItem },
  };
};

const isValidUnicode = (value: string): boolean => {
  for (const character of value) {
    if (/^[\uD800-\uDFFF]$/u.test(character)) return false;
  }
  return true;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
  return `{${entries.join(",")}}`;
};

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export const makeInputId = (environmentId: string, threadId: string, requestId: string): string =>
  `input_${hash(`${environmentId}\u0000${threadId}\u0000${requestId}`).slice(0, 48)}`;

export const inputDefinitionHash = (request: NativeInputRequest): string => hash(stableJson({
  capability: request.capability,
  requestKind: request.requestKind ?? "question",
  questions: request.questions,
}));

const normalizeQuestion = (value: unknown): InputQuestion => {
  if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.prompt !== "string" ||
    !isValidUnicode(value.prompt) || typeof value.required !== "boolean") {
    throw new InputDomainError("input question is malformed");
  }
  if (value.prompt.length > 100_000) throw new InputDomainError("input question exceeds its bound");
  if (value.kind !== "single_choice" && value.kind !== "multi_choice" && value.kind !== "free_text") {
    throw new InputDomainError("input question type is unsupported");
  }
  const rawChoices = value.choices;
  if (!Array.isArray(rawChoices)) throw new InputDomainError("input question choices are malformed");
  const allowCustomAnswer = value.allowCustomAnswer === undefined ? true : value.allowCustomAnswer;
  if (typeof allowCustomAnswer !== "boolean") throw new InputDomainError("input custom-answer setting is malformed");
  if (rawChoices.length > INPUT_MAX_CHOICES || (value.kind === "free_text" && rawChoices.length !== 0) ||
    (value.kind !== "free_text" && rawChoices.length === 0)) {
    throw new InputDomainError("input question choices are unsupported");
  }
  if (value.kind === "free_text" && !allowCustomAnswer) throw new InputDomainError("free-text question does not allow an answer");
  const choices = rawChoices.map((choice): InputChoice => {
    if (!isRecord(choice) || !isNonEmptyString(choice.value) || typeof choice.label !== "string" ||
      choice.label.length === 0 || !isValidUnicode(choice.value) || !isValidUnicode(choice.label) ||
      choice.value.length > 2_048 || choice.label.length > 16_000 ||
      (choice.description !== undefined && (typeof choice.description !== "string" ||
        choice.description.length > 16_000 || !isValidUnicode(choice.description)))) {
      throw new InputDomainError("input choice is malformed");
    }
    return {
      value: choice.value,
      label: choice.label,
      ...(choice.description === undefined ? {} : { description: choice.description }),
    };
  });
  if (new Set(choices.map((choice) => choice.value)).size !== choices.length) {
    throw new InputDomainError("input choices contain duplicate values");
  }
  return {
    id: value.id,
    prompt: value.prompt,
    kind: value.kind,
    required: value.required,
    allowCustomAnswer,
    choices,
  };
};

export const normalizeInputRequest = (value: unknown): NativeInputRequest => {
  if (!isRecord(value) || !isNonEmptyString(value.threadId) || !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.revisionHash) || !isNonEmptyString(value.capability) ||
    typeof value.terminal !== "boolean" ||
    !(value.terminalState === null || typeof value.terminalState === "string") ||
    (value.requestKind !== undefined && value.requestKind !== "question" && value.requestKind !== "approval") ||
    !Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > INPUT_MAX_QUESTIONS) {
    throw new InputDomainError("native input request is malformed");
  }
  if (value.displayTitle !== undefined && (typeof value.displayTitle !== "string" ||
    value.displayTitle.length > INPUT_MAX_DISPLAY_TITLE_UTF16 || !isValidUnicode(value.displayTitle))) {
    throw new InputDomainError("input display title is malformed");
  }
  const questions = value.questions.map(normalizeQuestion);
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new InputDomainError("input request contains duplicate question ids");
  }
  const nativeT3Anchor = normalizeNativeT3Anchor(value.nativeT3Anchor, value.threadId, value.requestId);
  const request: NativeInputRequest = {
    threadId: value.threadId,
    requestId: value.requestId,
    revisionHash: value.revisionHash,
    capability: value.capability,
    ...(value.displayTitle === undefined ? {} : { displayTitle: value.displayTitle }),
    terminal: value.terminal,
    terminalState: value.terminalState,
    ...(value.requestKind === undefined ? {} : { requestKind: value.requestKind }),
    questions,
    ...(nativeT3Anchor === undefined ? {} : { nativeT3Anchor }),
  };
  if (Buffer.byteLength(stableJson(request), "utf8") > INPUT_MAX_REQUEST_JSON_BYTES) {
    throw new InputDomainError("native input request exceeds its storage bound");
  }
  return request;
};

export const isEligibleInputThread = (thread: InputThread): boolean => {
  if (!isNonEmptyString(thread.id) || thread.archived === true || thread.deleted === true ||
    thread.delegated === true || thread.approvalRequest === true ||
    thread.kind === "delegated" || thread.kind === "subagent" || thread.kind === "approval" ||
    thread.relationshipToParent === "subagent") return false;
  return thread.currentRouter === true || thread.active === true || thread.kind === "main" || thread.kind === "fork";
};

export const emptyInputAnswers = (): InputAnswers => Object.freeze({});

export const isInputBatchComplete = (questions: readonly InputQuestion[], answers: InputAnswers): boolean =>
  questions.every((question) => {
    const answer = answers[question.id];
    if (!question.required) return answer === undefined || answer.kind === "skipped" || answer.kind === question.kind;
    if (!answer || answer.kind !== question.kind) return false;
    if (question.kind === "free_text") return typeof answer.value === "string" && answer.value.trim().length > 0;
    if (question.kind === "single_choice") return typeof answer.value === "string" && answer.value.trim().length > 0;
    return (Array.isArray(answer.value) && answer.value.length > 0) ||
      typeof answer.customText === "string" && answer.customText.trim().length > 0;
  });

export const nativeInputAnswers = (
  questions: readonly InputQuestion[],
  answers: InputAnswers,
): Readonly<Record<string, string | readonly string[] | null>> => {
  if (!isInputBatchComplete(questions, answers)) throw new InputDomainError("input batch is incomplete");
  const result: Record<string, string | readonly string[] | null> = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (!answer) continue;
    if (!question.required && ((answer.kind === "free_text" && typeof answer.value === "string" && answer.value.trim() === "") ||
      (answer.kind === "single_choice" && typeof answer.value === "string" && answer.value.trim() === "") ||
      (answer.kind === "multi_choice" && Array.isArray(answer.value) && answer.value.length === 0 &&
        (typeof answer.customText !== "string" || answer.customText.trim() === "")))) continue;
    if (answer.kind === "skipped") result[question.id] = null;
    else if (answer.kind === "free_text" && typeof answer.value === "string" && answer.value.trim() !== "") result[question.id] = answer.value.trim();
    else if (answer.kind === "single_choice" && typeof answer.value === "string") {
      if (answer.contributionId === null) {
        if (!question.choices.some((choice) => choice.value === answer.value)) {
          throw new InputDomainError("input answer does not match its question");
        }
        result[question.id] = answer.value;
      } else {
        if (!question.allowCustomAnswer) throw new InputDomainError("input answer does not match its question");
        result[question.id] = answer.value.trim();
      }
    } else if (answer.kind === "multi_choice" && typeof answer.customText === "string" && answer.customText.trim() !== "") {
      if (!question.allowCustomAnswer) throw new InputDomainError("input answer does not match its question");
      result[question.id] = answer.customText.trim();
    } else if (answer.kind === "multi_choice" && Array.isArray(answer.value)) {
      const selectedValues = answer.value as readonly string[];
      if (selectedValues.some((value) => !question.choices.some((choice) => choice.value === value))) {
        throw new InputDomainError("input answer does not match its question");
      }
      const selected = question.choices.filter((choice) => selectedValues.includes(choice.value)).map((choice) => choice.value);
      if (selected.length > 0) result[question.id] = selected;
      else if (question.required) throw new InputDomainError("input answer does not match its question");
    }
    else throw new InputDomainError("input answer does not match its question");
  }
  return result;
};

const answerRecordEquals = (left: InputAnswerRecord | undefined, right: InputAnswerRecord): boolean =>
  left !== undefined && left.kind === right.kind && left.contributionId === right.contributionId &&
  left.customText === right.customText && stableJson(left.value) === stableJson(right.value);

const compareUpdateOrder = (
  leftEpoch: number,
  leftUpdateId: number,
  rightEpoch: number,
  rightUpdateId: number,
): number => {
  if (leftEpoch < rightEpoch) return -1;
  if (leftEpoch > rightEpoch) return 1;
  if (leftUpdateId < rightUpdateId) return -1;
  if (leftUpdateId > rightUpdateId) return 1;
  return 0;
};

const compareEventToAnswer = (event: InputEvent, answer: InputAnswerRecord): number =>
  compareUpdateOrder(event.updateEpoch ?? 0, event.updateId, answer.updateEpoch ?? 0, answer.updateId);

const compactOptionOrder = (
  values: Readonly<Record<string, number>>,
  question: InputQuestion,
  version: 1 | undefined,
): Readonly<Record<string, number>> => {
  const compacted: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    const compactIndex = version === 1 && /^c(?:[0-9]|[1-7][0-9])$/u.test(key)
      ? Number(key.slice(1))
      : question.choices.findIndex((choice) => choice.value === key);
    if (compactIndex >= 0 && compactIndex < question.choices.length && Number.isSafeInteger(value)) {
      compacted[`c${compactIndex}`] = value;
    }
  }
  return compacted;
};

export const reduceInputEvent = (args: {
  readonly inputId: string;
  readonly request: NativeInputRequest;
  readonly draftRevision: number;
  readonly answers: InputAnswers;
  readonly event: InputEvent;
}): InputEventReduction => {
  const { inputId, request, draftRevision, answers, event } = args;
  const updateEpoch = event.updateEpoch ?? 0;
  if (request.terminal) return { kind: "ignored", reason: "terminal" };
  if (event.inputId !== inputId || event.requestRevision !== request.revisionHash) return { kind: "ignored", reason: "stale_request" };
  if (!Number.isSafeInteger(event.updateId) || event.updateId < 0 ||
    (event.updateEpoch !== undefined && (!Number.isSafeInteger(event.updateEpoch) || event.updateEpoch < 0)) ||
    !Number.isSafeInteger(event.draftRevision) ||
    event.draftRevision < 0 || event.draftRevision > draftRevision) {
    return { kind: "ignored", reason: "stale_draft" };
  }
  if (event.action === "stale") return { kind: "ignored", reason: "stale" };
  if (event.action === "submit") {
    if (event.draftRevision !== draftRevision) return { kind: "ignored", reason: "stale_draft" };
    if (event.questionId !== null || !isInputBatchComplete(request.questions, answers)) {
      return { kind: "ignored", reason: "incomplete_or_malformed_submit" };
    }
    return { kind: "submit" };
  }
  if (event.questionId === null) return { kind: "ignored", reason: "missing_question" };
  const question = request.questions.find((item) => item.id === event.questionId);
  if (!question) return { kind: "ignored", reason: "unknown_question" };
  const existing = answers[question.id];
  const isMultiChoiceToggle = question.kind === "multi_choice" &&
    (event.action === "select" || event.action === "deselect");
  const editsCurrentContribution = event.action === "answer" && event.edited === true &&
    existing?.contributionId === event.contributionId;
  if (!isMultiChoiceToggle && existing?.changedAtDraftRevision !== undefined && event.draftRevision < existing.changedAtDraftRevision &&
    !editsCurrentContribution) return { kind: "ignored", reason: "stale_question" };
  const currentValue = existing?.value;
  let next: InputAnswerRecord;

  if (event.action === "answer") {
    if ((question.kind !== "free_text" && !question.allowCustomAnswer) || typeof event.text !== "string" ||
      event.text.length > INPUT_MAX_ANSWER_UTF16 || !isValidUnicode(event.text) ||
      !isNonEmptyString(event.contributionId)) return { kind: "ignored", reason: "invalid_text_answer" };
    if (event.edited === true && existing?.contributionId !== event.contributionId) {
      return { kind: "ignored", reason: "superseded_contribution" };
    }
    if (existing && compareEventToAnswer(event, existing) < 0) return { kind: "ignored", reason: "reordered_event" };
    if (question.kind === "free_text") {
      next = {
        kind: "free_text", value: event.text, contributionId: event.contributionId,
        updateId: event.updateId, updateEpoch,
      };
    } else if (question.kind === "single_choice") {
      next = {
        kind: "single_choice", value: event.text, contributionId: event.contributionId,
        updateId: event.updateId, updateEpoch,
      };
    } else {
      next = {
        kind: "multi_choice",
        value: [],
        customText: event.text,
        contributionId: event.contributionId,
        updateId: event.updateId,
        updateEpoch,
      };
    }
  } else if (event.action === "select" || event.action === "deselect") {
    if ((question.kind !== "single_choice" && question.kind !== "multi_choice") || typeof event.value !== "string" ||
      !question.choices.some((choice) => choice.value === event.value)) {
      return { kind: "ignored", reason: "invalid_choice" };
    }
    if (question.kind === "single_choice") {
      if (existing && compareEventToAnswer(event, existing) < 0) return { kind: "ignored", reason: "reordered_event" };
      if (event.action !== "select") return { kind: "ignored", reason: "invalid_single_choice_action" };
      next = {
        kind: "single_choice", value: event.value, contributionId: null,
        updateId: event.updateId, updateEpoch,
      };
    } else {
      const optionKey = `c${question.choices.findIndex((choice) => choice.value === event.value)}`;
      const optionOrderVersion = existing?.optionOrderVersion;
      const optionDraftRevisions = compactOptionOrder(existing?.optionDraftRevisions ?? {}, question, optionOrderVersion);
      const optionUpdateIds = compactOptionOrder(existing?.optionUpdateIds ?? {}, question, optionOrderVersion);
      const optionUpdateEpochs = compactOptionOrder(existing?.optionUpdateEpochs ?? {}, question, optionOrderVersion);
      const nonOptionRevision = existing?.nonOptionChangedAtDraftRevision ??
        (existing && (existing.kind !== "multi_choice" || existing.contributionId !== null ||
          existing.customText !== undefined || existing.optionDraftRevisions === undefined)
          ? existing.changedAtDraftRevision
          : undefined);
      if (nonOptionRevision !== undefined && event.draftRevision < nonOptionRevision) {
        return { kind: "ignored", reason: "stale_question" };
      }
      if (compareUpdateOrder(
        updateEpoch,
        event.updateId,
        optionUpdateEpochs[optionKey] ?? 0,
        optionUpdateIds[optionKey] ?? -1,
      ) < 0) {
        return { kind: "ignored", reason: "reordered_event" };
      }
      const selected = new Set(Array.isArray(currentValue) ? currentValue : []);
      const wasSelected = selected.has(event.value);
      const selectedValues = [...selected].sort();
      const shouldBeSelected = event.action === "select";
      const eventIsLatest = !existing || compareEventToAnswer(event, existing) >= 0;
      const updateId = eventIsLatest ? event.updateId : existing.updateId;
      const latestUpdateEpoch = eventIsLatest ? updateEpoch : existing.updateEpoch ?? 0;
      const nextOptionUpdateIds = { ...optionUpdateIds, [optionKey]: event.updateId };
      const nextOptionUpdateEpochs = { ...optionUpdateEpochs, [optionKey]: updateEpoch };
      if (shouldBeSelected === wasSelected) {
        const unchanged: InputAnswerRecord = {
          kind: "multi_choice",
          value: selectedValues,
          contributionId: null,
          updateId,
          updateEpoch: latestUpdateEpoch,
          optionOrderVersion: 1,
          optionDraftRevisions,
          optionUpdateIds: nextOptionUpdateIds,
          optionUpdateEpochs: nextOptionUpdateEpochs,
          ...(existing?.changedAtDraftRevision === undefined ? {} : { changedAtDraftRevision: existing.changedAtDraftRevision }),
          ...(nonOptionRevision === undefined ? {} : { nonOptionChangedAtDraftRevision: nonOptionRevision }),
        };
        return {
          kind: "unchanged",
          answers: { ...answers, [question.id]: unchanged },
          draftRevision,
        };
      }
      if ((optionDraftRevisions[optionKey] ?? 0) > event.draftRevision) {
        return { kind: "ignored", reason: "stale_question" };
      }
      if (shouldBeSelected) selected.add(event.value);
      else selected.delete(event.value);
      const nextSelectedValues = [...selected].sort();
      const nextDraftRevision = draftRevision + 1;
      const nextOptionDraftRevisions = { ...optionDraftRevisions, [optionKey]: nextDraftRevision };
      const changed: InputAnswerRecord = {
        kind: "multi_choice",
        value: nextSelectedValues,
        contributionId: null,
        updateId,
        updateEpoch: latestUpdateEpoch,
        optionOrderVersion: 1,
        optionDraftRevisions: nextOptionDraftRevisions,
        optionUpdateIds: nextOptionUpdateIds,
        optionUpdateEpochs: nextOptionUpdateEpochs,
        changedAtDraftRevision: nextDraftRevision,
        ...(nonOptionRevision === undefined ? {} : { nonOptionChangedAtDraftRevision: nonOptionRevision }),
      };
      return {
        kind: "changed",
        answers: { ...answers, [question.id]: changed },
        draftRevision: nextDraftRevision,
      };
    }
  } else if (event.action === "skip") {
    if (question.required || existing && compareEventToAnswer(event, existing) < 0) {
      return { kind: "ignored", reason: "skip_not_allowed" };
    }
    next = {
      kind: "skipped", value: null, contributionId: null,
      updateId: event.updateId, updateEpoch,
    };
  } else {
    return { kind: "ignored", reason: "unsupported_action" };
  }

  if (answerRecordEquals(existing, next)) {
    const nextAnswers = existing && compareEventToAnswer(event, existing) > 0
      ? {
        ...answers,
        [question.id]: {
          ...next,
          ...(existing.changedAtDraftRevision === undefined ? {} : { changedAtDraftRevision: existing.changedAtDraftRevision }),
        },
      }
      : answers;
    return { kind: "unchanged", answers: nextAnswers, draftRevision };
  }
  const nextDraftRevision = draftRevision + 1;
  if (question.kind === "multi_choice") {
    next = { ...next, nonOptionChangedAtDraftRevision: nextDraftRevision };
  }
  return {
    kind: "changed",
    answers: { ...answers, [question.id]: { ...next, changedAtDraftRevision: nextDraftRevision } },
    draftRevision: nextDraftRevision,
  };
};

const takePrefix = (value: string, maxUtf16: number): string => {
  let units = 0;
  let result = "";
  for (const character of value) {
    if (units + character.length > maxUtf16) break;
    result += character;
    units += character.length;
  }
  return result;
};

const splitUnicode = (value: string, maxUtf16: number): string[] => {
  const parts: string[] = [];
  let remaining = value;
  while (remaining.length > maxUtf16) {
    const part = takePrefix(remaining, maxUtf16);
    if (part.length === 0) throw new InputDomainError("input text cannot be split safely");
    parts.push(part);
    remaining = remaining.slice(part.length);
  }
  if (remaining.length > 0 || parts.length === 0) parts.push(remaining);
  return parts;
};

const choiceLabel = (choice: InputChoice): string => choice.description
  ? `${choice.label} — ${choice.description}`
  : choice.label;

const answerDraft = (question: InputQuestion, answer: InputAnswerRecord | undefined): string => {
  if (!answer) return "";
  if (answer.kind === "skipped") return "Your current answer: Skipped";
  if (answer.kind === "free_text") {
    return typeof answer.value === "string" ? `Your current answer:\n${answer.value}` : "";
  }
  if (answer.kind === "single_choice") {
    if (typeof answer.value !== "string") return "";
    if (answer.contributionId !== null) return `Your current custom answer:\n${answer.value}`;
    const choice = question.choices.find((item) => item.value === answer.value);
    return `Your current answer: ${choice ? choiceLabel(choice) : answer.value}`;
  }
  if (answer.kind === "multi_choice") {
    if (typeof answer.customText === "string" && answer.customText.trim() !== "") {
      return `Your current custom answer:\n${answer.customText}`;
    }
    const selected = question.choices.filter((choice) => Array.isArray(answer.value) && answer.value.includes(choice.value));
    return selected.length > 0 ? `Your current selections:\n${selected.map(choiceLabel).join("\n")}` : "";
  }
  return "";
};

const questionBody = (question: InputQuestion, answer: InputAnswerRecord | undefined): string => {
  const prompt = question.kind === "free_text"
    ? `${question.prompt}\n\nReply to this message with your answer as text.`
    : `${question.prompt}\n\nOptions:\n${question.choices.map((choice, index) => `${index + 1}. ${choiceLabel(choice)}`).join("\n")}` +
      (question.allowCustomAnswer ? "\n\nOr reply to this message with a custom answer as text." : "");
  const draft = answerDraft(question, answer);
  const instructions = "Photos, files and voice messages do not submit questionnaire answers.";
  return draft.length > 0 ? `${prompt}\n\n${instructions}\n\n${draft}` : `${prompt}\n\n${instructions}`;
};

const questionButtons = (question: InputQuestion, answer: InputAnswerRecord | undefined): InputButton[][] => {
  if (question.kind === "free_text") {
    return question.required ? [] : [[{ label: "Skip", action: "skip" }]];
  }
  const selected = new Set(Array.isArray(answer?.value)
    ? answer.value
    : typeof answer?.value === "string" ? [answer.value] : []);
  const rows: InputButton[][] = question.choices.map((choice, index) => {
    const isSelected = selected.has(choice.value);
    const action = question.kind === "multi_choice" && isSelected ? "deselect" : "select";
    const verb = question.kind === "multi_choice" && isSelected ? "Unset" : question.kind === "single_choice" && isSelected ? "Selected" : "Select";
    return [{ label: `${verb} ${index + 1}`, action, value: choice.value } satisfies InputButton];
  });
  if (!question.required) rows.push([{ label: "Skip", action: "skip" }]);
  return rows;
};

export const renderInputBatch = (args: {
  readonly request: NativeInputRequest;
  readonly answers: InputAnswers;
  readonly canSubmit?: boolean;
  readonly submissionRejected?: boolean;
  readonly submissionUncertain?: boolean;
}): RenderedInputMessage[] => {
  if (args.request.terminal) return [];
  const messages: RenderedInputMessage[] = [];
  args.request.questions.forEach((question, index) => {
    const answer = args.answers[question.id];
    const body = questionBody(question, answer);
    const title = args.request.displayTitle?.trim().length
      ? `Chat: ${takePrefix(args.request.displayTitle.trim(), 256)}\n`
      : "";
    const basePrefix = `${title}Question ${index + 1}/${args.request.questions.length}`;
    const chunks = splitUnicode(body, Math.max(1, INPUT_MAX_MESSAGE_UTF16 - basePrefix.length - 48));
    const buttons = args.submissionUncertain ? [] : questionButtons(question, answer);
    chunks.forEach((chunk, chunkIndex) => {
      const partLabel = chunks.length > 1 ? ` · part ${chunkIndex + 1}/${chunks.length}` : "";
      const prefix = `${basePrefix}${partLabel}\n\n`;
      const text = `${prefix}${chunk}`;
      if (text.length > INPUT_MAX_MESSAGE_UTF16) throw new InputDomainError("rendered Telegram input exceeds its message bound");
      messages.push({
        questionId: question.id,
        fragment: chunkIndex,
        text,
        buttons: chunkIndex === chunks.length - 1 ? buttons : [],
      });
    });
  });
  const title = args.request.displayTitle?.trim().length
    ? `Chat: ${takePrefix(args.request.displayTitle.trim(), 256)}\n`
    : "";
  const statusCard = (text: string): RenderedInputMessage => {
    const cardText = `${title}Submission status\n\n${text}`;
    if (cardText.length > INPUT_MAX_MESSAGE_UTF16) throw new InputDomainError("rendered Telegram input exceeds its message bound");
    return { questionId: null, fragment: 0, text: cardText, buttons: [] };
  };
  if (args.submissionUncertain) {
    messages.push(statusCard("T3 may have received this submission. The saved draft is preserved and will not be sent again."));
    return messages;
  }
  if (args.submissionRejected) {
    messages.push(statusCard("T3 did not accept that submission. Change an answer before submitting again."));
  } else if (args.canSubmit !== false && isInputBatchComplete(args.request.questions, args.answers)) {
    messages.push({
      questionId: null,
      fragment: 0,
      text: "Submit these answers to T3?",
      buttons: [[{ label: "Submit", action: "submit" }]],
    });
  }
  return messages;
};
