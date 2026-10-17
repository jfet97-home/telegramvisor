import { useEffect, useState } from "react";
import type { CompletionGap } from "../../src/completion-gap.js";
import { getCsrfToken, loadAccess, sessionHeaders } from "./access.js";

type CoverageResponse = {gaps: Array<CompletionGap & {title?: string}>; recoveryAvailable: boolean};

export function CompletionCoverage() {
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const refresh = async (signal?: AbortSignal) => {
    const response = await fetch("/api/completion-gaps", {credentials: "omit", headers: sessionHeaders(), ...(signal ? {signal} : {})});
    if (!response.ok) {
      if (response.status === 401) await loadAccess();
      throw new Error("Completion coverage could not be loaded. Refresh after signing in.");
    }
    setData(await response.json() as CoverageResponse);
  };
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal).catch(() => {if (!abort.signal.aborted) setError("Completion coverage could not be loaded.");});
    return () => abort.abort();
  }, []);
  const requestRecovery = async (gap: CompletionGap) => {
    setBusy(gap.id);setError("");setMessage("");
    try {
      const response = await fetch("/api/completion-recovery", {method: "POST", credentials: "omit",
        headers: {"Content-Type": "application/json", ...sessionHeaders(), "x-csrf-token": getCsrfToken()},
        body: JSON.stringify({gapId: gap.id, threadId: gap.threadId})});
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) await loadAccess();
        throw new Error("The request outcome could not be confirmed. Refresh to inspect it before trying again.");
      }
      const result = await response.json() as {status: string; reason: string};
      const messages: Record<string, string> = {
        requested: "Recovery update requested. Open the chat to follow its response.",
        already_requested: "This recovery update was already requested. Open the chat to follow its response.",
        uncertain: "Delivery is unconfirmed. Check again to inspect the original request; it will not be resent.",
        rejected: "T3 rejected this request. No recovery update has been confirmed.",
        deferred: result.reason === "owner_input_pending" ? "Answer the chat’s pending question or approval first, then try again." : "The chat is not ready for a recovery request. Try again after its current activity changes.",
        unavailable: "This chat is unavailable or excluded from completion notifications.",
      };
      setMessage(messages[result.status] ?? "Refresh to inspect the recovery request.");
      await refresh();
    } catch (cause) {setError(cause instanceof Error ? cause.message : "The recovery request could not be confirmed.");}
    finally {setBusy(null);}
  };
  return <section className="panel stack">
    <div className="row between"><h2>Recent completion coverage</h2>
      <button type="button" onClick={() => {setError("");void refresh().catch(() => setError("Completion coverage could not be loaded."));}}>Refresh coverage</button>
    </div>
    <p>For oversized chats, completion notifications use recent history. Older work outside that history may not have been checked. You can ask a chat to check its current results and report again.</p>
    <p className="muted">Recovery starts a fresh assessment and may start a new turn in an idle chat. It does not mark old work as completed or resend an old notification.</p>
    <p role="status">{message}</p>
    {error && <p role="alert">{error}</p>}
    {data?.gaps.length === 0 && <p className="muted">No retained history gaps.</p>}
    {data?.gaps.map(gap => {
      const state = gap.recovery?.state;
      const confirmed = state === "accepted" || state === "reconciled";
      const uncertain = state === "dispatching" || state === "uncertain";
      return <article className="stack" key={gap.id}>
        <a href={`t3-thread://v1/${gap.threadId}`}>{gap.title ?? gap.threadId}</a>
        <p>{gap.reason === "incomplete_turn" ? "A recent turn is missing information needed to check its completion." : "Earlier history was outside the completion reader’s view."}</p>
        <button type="button" disabled={busy !== null || !data.recoveryAvailable || confirmed || state === "rejected"}
          onClick={() => void requestRecovery(gap)}>
          {busy === gap.id ? "Checking request…" : confirmed ? "Recovery requested" : uncertain ? "Check recovery request" : state === "rejected" ? "Recovery request rejected" : "Ask chat for recovery update"}
        </button>
      </article>;
    })}
    {data && !data.recoveryAvailable && <p className="muted">Recovery dialogue is unavailable on this installation.</p>}
  </section>;
}
