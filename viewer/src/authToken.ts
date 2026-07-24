const TOKEN_KEY = "pps_auth_token";

export function getAuthToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null): void {
  if (token === null || token === "") {
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
  }
}

/** Single place header-attachment logic lives; used by both request<T>() and AuthenticatedImage. */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token !== null && token !== "" ? { Authorization: `Bearer ${token}` } : {};
}
