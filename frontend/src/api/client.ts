const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function getToken() {
  return localStorage.getItem("vcuf_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "UNKNOWN_ERROR", body?.message);
  }
  return body as T;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    permissions: string[];
  };
}

export interface Client {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  emailPrimary?: string | null;
  phonePrimary?: string | null;
  clientType?: string | null;
  notes?: string | null;
  source?: string | null;
  createdAt: string;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => request<LoginResponse["user"]>("/auth/me"),
  clients: {
    list: () => request<Client[]>("/crm/clients"),
    get: (id: string) => request<Client>(`/crm/clients/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Client>("/crm/clients", { method: "POST", body: JSON.stringify(data) }),
    search: (q: string) => request<Client[]>(`/crm/clients/search?q=${encodeURIComponent(q)}`),
  },
};

export { getToken };
export function setToken(token: string | null) {
  if (token) localStorage.setItem("vcuf_token", token);
  else localStorage.removeItem("vcuf_token");
}
