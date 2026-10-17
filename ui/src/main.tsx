import {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {CompletionCoverage} from "./completion-coverage.js";
import {clearAccess, getCsrfToken, getSessionToken, loadAccess, sessionHeaders, setSessionToken} from "./access.js";
import "./style.css";

type Policy = {generation: number; excludedThreadIds: string[]; interactiveThreadId: string | null};
type Activity = {id: string; kind: string; threadId: string | null; state: string; reason: string | null; detail: string | null; createdAt: number};
type Snapshot = {
  enabled: boolean; inputEnabled: boolean;
  threads: Array<{id: string; title: string}>;
  threadPolicy: Policy;
  history: Activity[];
  status: {t3Connected: boolean; telegramState: string; modelState: string; inputState: string; inputLastErrorPhase: string | null;
    readiness: {ready: boolean}; store: {completionCoverageGaps?: number; jobs: Record<string, number>} | null};
};
const call = async (path: string, body?: unknown) => {
  const response = await fetch(path, {credentials: "omit", method: body === undefined ? "GET" : "POST",
    headers: {...sessionHeaders(), ...(body === undefined ? {} : {"Content-Type": "application/json", "x-csrf-token": getCsrfToken()})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  if (response.status === 401) await loadAccess();
  const value = await response.json() as unknown;
  if (!response.ok) throw new Error(typeof value === "object" && value !== null && "message" in value ? String(value.message) : "The request could not be confirmed. Refresh before trying again.");
  return value;
};

function ChatSettings({data, draft, onDraft}: {data: Snapshot; draft: Policy | null; onDraft: (value: Policy | null) => void}) {
  const [form, setForm] = useState(draft ?? data.threadPolicy);
  const [dirty, setDirty] = useState(draft !== null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {if (!dirty) setForm(data.threadPolicy);}, [data.threadPolicy, dirty]);
  const chats = [...data.threads];
  for (const id of [...form.excludedThreadIds, ...(form.interactiveThreadId ? [form.interactiveThreadId] : [])]) {
    if (!chats.some(chat => chat.id === id)) chats.push({id, title: "Unavailable chat"});
  }
  const change = (patch: Partial<Policy>) => {const next = {...form, ...patch};setForm(next);onDraft(next);setDirty(true);setMessage("");setError("");};
  return <form className="panel stack" action="/api/chat-policy" method="post" onSubmit={event => {
    event.preventDefault();setBusy(true);setMessage("");setError("");
    void call("/api/chat-policy", form).then(value => {setForm(value as Policy);setDirty(false);onDraft(null);setMessage("Chat settings saved.");})
      .catch(cause => setError(cause instanceof Error ? cause.message : "Settings could not be confirmed. Reload before saving again."))
      .finally(() => setBusy(false));
  }}>
    <h2>Chat settings</h2>
    <label htmlFor="interactive-chat">Interactive questionnaire chat</label>
    <select id="interactive-chat" name="interactiveThreadId" value={form.interactiveThreadId ?? ""} onChange={event => change({interactiveThreadId: event.target.value || null})}>
      <option value="">None</option>
      {chats.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
    </select>
    <p className="muted">This chat can answer questionnaires through Telegram, including when excluded below. Other eligible chats receive an input-needed notice.</p>
    <fieldset className="stack"><legend>Excluded chats</legend>
      <p>Excluded chats receive no new recaps, full replies or input-needed notices.</p>
      <label htmlFor="chat-search">Find a chat</label>
      <input id="chat-search" name="search" type="search" autoCapitalize="none" spellCheck={false} value={search} onChange={event => setSearch(event.target.value)}/>
      <div className="chat-list">{chats.filter(chat => `${chat.title} ${chat.id}`.toLowerCase().includes(search.toLowerCase()))
        .sort((a,b) => a.title.localeCompare(b.title)).map(chat => <label className="check" key={chat.id}>
          <input type="checkbox" name="excludedThreadIds" value={chat.id} checked={form.excludedThreadIds.includes(chat.id)}
            onChange={event => change({excludedThreadIds: event.target.checked ? [...form.excludedThreadIds, chat.id] : form.excludedThreadIds.filter(id => id !== chat.id)})}/>
          <span>{chat.title}<small>{chat.id}</small></span>
        </label>)}</div>
    </fieldset>
    <div className="row"><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Save chat settings"}</button>
      <button type="button" disabled={busy || !dirty} onClick={() => {setForm(data.threadPolicy);setDirty(false);onDraft(null);setError("");setMessage("Saved settings reloaded.");}}>Discard draft</button></div>
    <p role="status">{message}</p>{error && <p role="alert">{error}</p>}
  </form>;
}

function History({data}: {data: Snapshot}) {
  const [search, setSearch] = useState("");
  const names = new Map(data.threads.map(chat => [chat.id, chat.title]));
  const items = data.history.filter(item => `${item.kind} ${item.state} ${item.reason ?? ""} ${names.get(item.threadId ?? "") ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel stack"><h2>Notification history</h2>
    <label htmlFor="history-search">Find a notification</label><input id="history-search" name="search" type="search" value={search} onChange={event => setSearch(event.target.value)}/>
    {items.length === 0 && <p className="muted">No matching retained notifications.</p>}
    {items.map(item => <article className="history-item stack" key={`${item.kind}:${item.id}`}>
      <div className="row between"><strong>{item.threadId ? names.get(item.threadId) ?? "T3 chat" : "Telegram"}</strong><span className="badge">{item.state.replaceAll("_", " ")}</span></div>
      <p>{item.kind.replaceAll("_", " ")}{item.reason ? ` · ${item.reason.replaceAll("_", " ")}` : ""}</p>
      <div className="row between"><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
        {item.threadId && <a href={`t3-thread://v1/${item.threadId}`}>Open chat</a>}</div>
      {item.detail && <details><summary>Details</summary><pre>{item.detail}</pre></details>}
    </article>)}
  </section>;
}

function Dashboard({onSignOut, draft, onDraft}: {onSignOut: () => Promise<void>; draft: Policy | null; onDraft: (value: Policy | null) => void}) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [view, setView] = useState("history");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {try {const value = await call("/api/snapshot") as Snapshot;if (!cancelled) {setData(value);setError("");}}
      catch {if (!cancelled) setError("Telegramvisor could not be refreshed. Saved history and drafts are retained.");}};
    void refresh();const timer = setInterval(() => {if (document.visibilityState === "visible") void refresh();}, 5000);
    return () => {cancelled = true;clearInterval(timer);};
  }, []);
  const jobs = data?.status.store?.jobs;
  return <main><header className="row between"><div><h1>Telegramvisor</h1><p className="muted">Telegram notifications, replies and questionnaires.</p></div>
    <button type="button" onClick={() => {void onSignOut().catch(() => setError("Sign out could not be confirmed. Try again."));}}>Sign out</button></header>
    {error && <p role="alert">{error}</p>}
    {!data ? <p role="status">Loading Telegramvisor…</p> : <>
      <section className="panel stack" aria-label="Service status">
        <div className="row between"><strong>{data.status.t3Connected ? "T3 connected" : "T3 unavailable"}</strong>
          <span className="badge">{!data.enabled ? "Telegram disabled" : data.status.readiness.ready ? "Ready" : "Needs attention"}</span></div>
        <div className="row"><span>Telegram: {data.status.telegramState}</span><span>Recaps: {data.status.modelState}</span><span>Questions: {data.status.inputState}</span></div>
        {data.status.inputLastErrorPhase === "native_requests" && <p role="status">Current questions could not be read from T3. No question has been assumed answered.</p>}
        <div className="row"><span>Queued: {(jobs?.pending ?? 0) + (jobs?.ready ?? 0)}</span><span>Unconfirmed: {jobs?.unknown ?? 0}</span><span>History gaps: {data.status.store?.completionCoverageGaps ?? 0}</span></div>
      </section>
      <nav className="row" aria-label="Telegramvisor sections">{["history", "recovery", "chats"].map(name => <button key={name} type="button" aria-current={view === name ? "page" : undefined} onClick={() => setView(name)}>{name === "history" ? "History" : name === "recovery" ? "Recovery" : "Chats"}</button>)}</nav>
      {view === "history" && <History data={data}/>}{view === "recovery" && <CompletionCoverage/>}{view === "chats" && <ChatSettings data={data} draft={draft} onDraft={onDraft}/>}
    </>}
  </main>;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {void loadAccess().then(setAuthenticated).catch(() => setAuthenticated(false));
    const required = () => {setAuthenticated(false);if (getSessionToken()) setError("Sign in again. Your previous action has not been retried.");};
    window.addEventListener("telegramvisor-auth-required", required);return () => window.removeEventListener("telegramvisor-auth-required", required);
  }, []);
  if (authenticated === null) return <main><p role="status">Checking sign-in…</p></main>;
  if (authenticated) return <Dashboard draft={draft} onDraft={setDraft} onSignOut={async () => {await call("/auth/logout", {});clearAccess();setAuthenticated(false);setError("");}}/>;
  return <main className="signin"><h1>Telegramvisor</h1><p>Sign in with a single-use access token.</p>
    <p className="muted">Run <code>telegramvisor auth forge</code> in the service environment to obtain a token.</p>
    <form className="panel stack" action="/auth/login" method="post" onSubmit={event => {
      event.preventDefault();setBusy(true);setError("");
      void call("/auth/login", {token}).then(async value => {
        if (typeof value !== "object" || value === null || !("session" in value) || typeof value.session !== "string") throw new Error("The sign-in response could not be confirmed.");
        setSessionToken(value.session);setToken("");setAuthenticated(await loadAccess());
      }).catch(cause => setError(cause instanceof Error ? cause.message : "Sign-in failed.")).finally(() => setBusy(false));
    }}><label htmlFor="login-token">Access token</label><input id="login-token" name="token" type="password" required autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} maxLength={128} value={token} onChange={event => setToken(event.target.value)}/>
      <button type="submit" className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>{error && <p role="alert">{error}</p>}
    </form>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
