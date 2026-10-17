import WebSocket from "ws";

export class NativeRpcError extends Error {
  constructor(readonly outcome: "rejected" | "uncertain", readonly definiteRejection = false, readonly providerDisabled = false,
    readonly dispatchCommandFailure = false) {super("T3 access is unavailable.");}
}
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rejectedByName = (value: unknown, name: string, depth = 0): boolean => {
  if (depth > 20 || !record(value)) return false;
  if (value.name === name || value._tag === name) return true;
  return Object.values(value).some(child => Array.isArray(child) ? child.some(item => rejectedByName(item, name, depth + 1)) : rejectedByName(child, name, depth + 1));
};

/** Keeps native requests bounded and never exposes remote errors or credentials. */
export const makeNativeRpc = (baseUrl: string, token: string) =>
  (tag: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new NativeRpcError("rejected"));
    const url = new URL("/ws?orchestrationProtocol=2", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {headers: {Authorization: `Bearer ${token}`}, handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024});
    let finished = false;
    let sent = false;
    const finish = (error?: NativeRpcError, value?: unknown) => {
      if (finished) return;
      finished = true;clearTimeout(timer);signal.removeEventListener("abort", abort);ws.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new NativeRpcError(sent ? "uncertain" : "rejected"));
    const timer = setTimeout(abort, 20_000);
    signal.addEventListener("abort", abort, {once: true});
    ws.on("error", abort);ws.on("close", abort);
    ws.on("open", () => {
      if (finished || signal.aborted) return abort();
      if (ws.readyState !== WebSocket.OPEN) return finish(new NativeRpcError("rejected"));
      sent = true;
      try {ws.send(JSON.stringify({_tag: "Request", id: "telegramvisor", tag, payload, headers: []}), error => {if (error) abort();});}
      catch {abort();}
    });
    ws.on("message", (data, binary) => {
      if (binary) return abort();
      try {
        const decoded: unknown = JSON.parse(data.toString());
        for (const frame of (Array.isArray(decoded) ? decoded.flat(4) : [decoded])) {
          if (!record(frame)) return abort();
          if (frame._tag === "Ping") {ws.send(JSON.stringify({_tag: "Pong"}));continue;}
          if (frame._tag !== "Exit" || frame.requestId !== "telegramvisor") continue;
          if (!record(frame.exit)) return abort();
          if (frame.exit._tag === "Success") finish(undefined, frame.exit.value);
          else {
            const providerDisabled = rejectedByName(frame.exit, "ThreadManagementProviderInstanceDisabledError");
            const definite = providerDisabled || rejectedByName(frame.exit, "OrchestratorCommandPreviouslyRejectedError");
            const dispatchCommandFailure = tag === "orchestration.dispatchCommand" && rejectedByName(frame.exit, "OrchestrationV2DispatchCommandError");
            finish(new NativeRpcError(definite ? "rejected" : "uncertain", definite, providerDisabled, dispatchCommandFailure));
          }
        }
      } catch {abort();}
    });
  });
