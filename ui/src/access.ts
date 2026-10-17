let csrf = "";
export const getCsrfToken = () => csrf;
const sessionKey = "telegramvisor-session";
export const getSessionToken = () => typeof sessionStorage === "undefined" ? "" : sessionStorage.getItem(sessionKey) ?? "";
export const setSessionToken = (session: string) => { sessionStorage.setItem(sessionKey, session); };
export const sessionHeaders = () => ({"x-telegramvisor-session": getSessionToken()});

export const loadAccess = async (): Promise<boolean> => {
  const response = await fetch("/api/csrf", {credentials: "omit", headers: sessionHeaders()});
  if (!response.ok) {
    csrf = "";
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("telegramvisor-auth-required"));
    return false;
  }
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || !("csrf" in value) || typeof value.csrf !== "string") return false;
  csrf = value.csrf;
  return true;
};

export const clearAccess = () => { csrf = ""; if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(sessionKey); };
