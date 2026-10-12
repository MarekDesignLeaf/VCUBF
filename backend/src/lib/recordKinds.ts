// The kinds of record that have a page of their own, which a sentence can open
// by name: "otevři klienta Novák", "open the quote for Smith". Each opens the
// detail page the list links to; contacts and invoices have no detail page, so
// their list opens with the record picked out.

export const RECORD_KINDS = ["client", "contact", "lead", "job", "quote", "invoice", "employee", "job_opening", "playbook"] as const;

export type RecordKind = typeof RECORD_KINDS[number];

/** The page of a record, as the web application routes it. */
export function recordPath(kind: RecordKind, id: string): string {
  const encoded = encodeURIComponent(id);
  switch (kind) {
    case "client": return `/clients/${encoded}`;
    case "contact": return `/contacts?contact=${encoded}`;
    case "lead": return `/leads/${encoded}`;
    case "job": return `/jobs/${encoded}`;
    case "quote": return `/quotes/${encoded}`;
    case "invoice": return `/invoices?invoice=${encoded}`;
    case "employee": return `/employees/${encoded}/edit`;
    case "job_opening": return `/recruitment/${encoded}`;
    case "playbook": return `/playbooks/${encoded}`;
  }
}

/** The menu page each kind belongs to (VOICE_PAGE_ROUTES). */
export const RECORD_PAGE = {
  client: "clients",
  contact: "contacts",
  lead: "leads",
  job: "jobs",
  quote: "quotes",
  invoice: "invoices",
  employee: "employees",
  job_opening: "recruitment",
  playbook: "playbooks",
} as const satisfies Record<RecordKind, string>;
