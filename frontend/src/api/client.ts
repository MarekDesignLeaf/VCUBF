const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
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
    throw new ApiError(res.status, body?.error ?? "UNKNOWN_ERROR", body?.message, body);
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

// Keep in sync with backend/src/lib/actionContracts.ts JOB_STATUSES.
export const JOB_STATUSES = [
  "nova",
  "naplanovano",
  "v_realizaci",
  "ceka_na_material",
  "ceka_na_klienta",
  "dokonceno",
  "zruseno",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  nova: "New",
  naplanovano: "Scheduled",
  v_realizaci: "In progress",
  ceka_na_material: "Waiting for material",
  ceka_na_klienta: "Waiting for client",
  dokonceno: "Completed",
  zruseno: "Cancelled",
};

export interface Job {
  id: string;
  clientId: string;
  jobTitle: string;
  jobStatus: JobStatus;
  propertyAddress?: string | null;
  assignedUserId?: string | null;
  estimatedDurationHours?: number | null;
  requiredSkills?: string[];
  serviceCatalogueItemId?: string | null;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  notes?: string | null;
  createdAt: string;
  client?: { id: string; displayName: string };
  assignedUser?: { id: string; displayName: string } | null;
  serviceCatalogueItem?: { id: string; name: string } | null;
}

// Job Allocation and Capacity Management Module.
export interface CapacityResult {
  employeeId: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  weeklyCapacityHours: number;
  currentLoadHours: number;
  jobsCountedInLoad: number;
  jobsMissingEstimate: number;
  utilizationPct: number;
  overloaded: boolean;
}

export interface Employee {
  id: string;
  displayName: string;
  email: string;
  role: string;
  skills: string[];
  weeklyCapacityHours: number;
  capacity: CapacityResult | null;
}

// Employee and Permission Model — the fuller shape used by management
// screens (create/edit), which also exposes permissions and active status.
export const KNOWN_PERMISSIONS = ["crm.read", "crm.manage", "users.manage", "audit.read", "voice.execute"] as const;
export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];

export interface ManagedEmployee {
  id: string;
  displayName: string;
  email: string;
  role: string;
  permissions: string[];
  skills: string[];
  weeklyCapacityHours: number;
  isActive: boolean;
}

export interface AssignJobResult {
  job: Job;
  capacityWarning: { type: string; message?: string; [key: string]: unknown } | null;
  missingSkills: string[];
}

// Calendar and Scheduling Intelligence Module.
export interface OverloadFinding {
  employeeId: string;
  employeeName: string;
  weekStart: string;
  weekEnd: string;
  weeklyCapacityHours: number;
  currentLoadHours: number;
  utilizationPct: number;
}

export interface OverloadReport {
  generatedAt: string;
  weeksAhead: number;
  overloadedWeeks: OverloadFinding[];
  suggestions: string[];
}

export interface SuggestedEmployee {
  employeeId: string;
  employeeName: string;
  hasAllRequiredSkills: boolean;
  missingSkills: string[];
  earliestAvailableWeekStart: string | null;
  earliestAvailableWeekLoadHours: number | null;
  weeklyCapacityHours: number;
}

// Service Catalogue Module.
export interface ServiceCatalogueItem {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  basePriceMin?: number | null;
  basePriceMax?: number | null;
  priceUnit?: string | null;
  defaultDurationHours?: number | null;
  defaultRequiredSkills: string[];
  isActive: boolean;
  createdAt: string;
}

export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  lost: "Lost",
};

export interface Lead {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  serviceRequested?: string | null;
  location?: string | null;
  source?: string | null;
  urgency?: string | null;
  leadStatus: LeadStatus;
  notes?: string | null;
  convertedClientId?: string | null;
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
  jobs: {
    list: (params?: { clientId?: string; status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.clientId) qs.set("client_id", params.clientId);
      if (params?.status) qs.set("status", params.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<Job[]>(`/crm/jobs${suffix}`);
    },
    get: (id: string) => request<Job>(`/crm/jobs/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Job>("/crm/jobs", { method: "POST", body: JSON.stringify(data) }),
    changeStatus: (id: string, jobStatus: JobStatus) =>
      request<Job>(`/crm/jobs/${id}`, { method: "PUT", body: JSON.stringify({ job_status: jobStatus }) }),
    assign: (id: string, assignedUserId: string) =>
      request<AssignJobResult>(`/crm/jobs/${id}/assign`, {
        method: "PUT",
        body: JSON.stringify({ assigned_user_id: assignedUserId }),
      }),
  },
  employees: {
    list: () => request<Employee[]>("/crm/employees"),
    get: (id: string) => request<Employee>(`/crm/employees/${id}`),
    capacity: (id: string, week?: string) =>
      request<CapacityResult>(`/crm/employees/${id}/capacity${week ? `?week=${encodeURIComponent(week)}` : ""}`),
    getManaged: (id: string) => request<ManagedEmployee>(`/crm/employees/${id}/manage`),
    permissions: () => request<string[]>("/crm/employees/meta/permissions"),
    create: (data: Record<string, unknown>) =>
      request<ManagedEmployee>("/crm/employees", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<ManagedEmployee>(`/crm/employees/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  calendar: {
    jobs: (from: string, to: string) =>
      request<Job[]>(`/calendar/jobs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    overload: (weeksAhead?: number) =>
      request<OverloadReport>(`/calendar/overload${weeksAhead ? `?weeks_ahead=${weeksAhead}` : ""}`),
    suggest: (params: { estimatedDurationHours?: number; requiredSkills?: string[]; weeksAhead?: number }) => {
      const qs = new URLSearchParams();
      if (params.estimatedDurationHours) qs.set("estimated_duration_hours", String(params.estimatedDurationHours));
      if (params.requiredSkills && params.requiredSkills.length > 0)
        qs.set("required_skills", params.requiredSkills.join(","));
      if (params.weeksAhead) qs.set("weeks_ahead", String(params.weeksAhead));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<SuggestedEmployee[]>(`/calendar/suggest${suffix}`);
    },
  },
  catalogue: {
    list: (activeOnly?: boolean) =>
      request<ServiceCatalogueItem[]>(`/service-catalogue${activeOnly ? "?active_only=true" : ""}`),
    get: (id: string) => request<ServiceCatalogueItem>(`/service-catalogue/${id}`),
    create: (data: Record<string, unknown>) =>
      request<ServiceCatalogueItem>("/service-catalogue", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<ServiceCatalogueItem>(`/service-catalogue/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  leads: {
    list: (params?: { status?: string }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<Lead[]>(`/crm/leads${suffix}`);
    },
    get: (id: string) => request<Lead>(`/crm/leads/${id}`),
    create: (data: Record<string, unknown>) =>
      request<Lead>("/crm/leads", { method: "POST", body: JSON.stringify(data) }),
    convert: (id: string) =>
      request<{ lead: Lead; client: Client }>(`/crm/leads/${id}/convert`, { method: "POST" }),
  },
  command: {
    text: (text: string) =>
      request<{
        intent: string;
        interpreted: unknown;
        ok: boolean;
        data?: unknown;
        error?: string;
        message?: string;
      }>("/command/text", { method: "POST", body: JSON.stringify({ text }) }),
  },
};

export { getToken };
export function setToken(token: string | null) {
  if (token) localStorage.setItem("vcuf_token", token);
  else localStorage.removeItem("vcuf_token");
}
