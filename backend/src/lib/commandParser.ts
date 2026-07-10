// Text/Voice Understanding Layer — deterministic, rule-based intent parser.
//
// This is intentionally NOT an LLM call. Per the VCUF master documentation and
// the vcubf-programmer-skill "business logic rule", business decisions must be
// stored in structured form, not guessed by a prompt. This MVP slice proves
// the Voice/Text Command Layer -> Intent Layer -> Action Engine pipeline with
// a small, auditable set of deterministic patterns. It can be replaced or
// augmented by an LLM-assisted extraction step later WITHOUT changing the
// Action Engine underneath, because the parser's only job is to produce a
// structured ParsedCommand — the same shape an LLM-based parser would need to
// produce.
//
// If nothing matches, the result is `unrecognized` — the system must not
// guess (VCUF error handling rule).

export type ParsedCommand =
  | { intent: "create_client"; entities: { display_name: string; email_primary?: string; phone_primary?: string } }
  | {
      intent: "create_lead";
      entities: { name: string; service_requested?: string; email?: string; phone?: string };
    }
  | { intent: "create_job"; entities: { job_title: string; client_name: string } }
  | { intent: "change_job_status"; entities: { job_title: string; job_status: string } }
  | { intent: "convert_lead"; entities: { lead_name: string } }
  | { intent: "assign_job"; entities: { job_title: string; employee_name: string } }
  | { intent: "detect_overload"; entities: Record<string, never> }
  | { intent: "create_service"; entities: { name: string; category?: string } }
  | { intent: "list_quotes"; entities: { client_name?: string } }
  | { intent: "list_job_openings"; entities: Record<string, never> }
  | { intent: "create_learning_rule"; entities: { term: string; meaning: string } }
  | { intent: "list_learning_rules"; entities: Record<string, never> }
  | {
      intent: "log_communication";
      entities: { client_name: string; channel: string; direction: string; summary: string };
    }
  | { intent: "list_communications"; entities: { client_name?: string } }
  | { intent: "list_follow_ups"; entities: Record<string, never> }
  | { intent: "list_notifications"; entities: Record<string, never> }
  | { intent: "list_data_quality"; entities: Record<string, never> }
  | { intent: "list_clients"; entities: Record<string, never> }
  | { intent: "list_jobs"; entities: Record<string, never> }
  | { intent: "list_leads"; entities: Record<string, never> }
  | { intent: "unrecognized"; entities: Record<string, never> };

function extractLabelled(text: string, label: string): { value?: string; rest: string } {
  const re = new RegExp(`,?\\s*${label}\\s*[:]?\\s*([^,]+)`, "i");
  const match = text.match(re);
  if (!match) return { rest: text };
  const value = match[1].trim();
  const rest = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim();
  return { value, rest };
}

export function parseTextCommand(rawText: string): ParsedCommand {
  const text = rawText.trim();

  let m = text.match(/^(?:create|add|new)\s+client\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    const email = extractLabelled(rest, "email");
    rest = email.rest;
    const phone = extractLabelled(rest, "phone");
    rest = phone.rest;
    const displayName = rest.replace(/,\s*$/, "").trim();
    if (!displayName) return { intent: "unrecognized", entities: {} };
    return {
      intent: "create_client",
      entities: { display_name: displayName, email_primary: email.value, phone_primary: phone.value },
    };
  }

  m = text.match(/^(?:create|add|new)\s+lead\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    // Extract "for <service>" first — email/phone extraction is greedy and
    // would otherwise swallow a trailing "for ..." clause.
    const forMatch = rest.match(/\bfor\s+(.+)$/i);
    let service: string | undefined;
    if (forMatch) {
      service = forMatch[1].trim();
      rest = rest.slice(0, forMatch.index).trim();
    }
    const email = extractLabelled(rest, "email");
    rest = email.rest;
    const phone = extractLabelled(rest, "phone");
    rest = phone.rest;
    const name = rest.replace(/,\s*$/, "").trim();
    if (!name) return { intent: "unrecognized", entities: {} };
    return {
      intent: "create_lead",
      entities: { name, service_requested: service, email: email.value, phone: phone.value },
    };
  }

  m = text.match(/^(?:create|add|new)\s+job\s+(.+?)\s+for\s+(.+)$/i);
  if (m) {
    const jobTitle = m[1].trim();
    const clientName = m[2].trim();
    if (!jobTitle || !clientName) return { intent: "unrecognized", entities: {} };
    return { intent: "create_job", entities: { job_title: jobTitle, client_name: clientName } };
  }

  m = text.match(/^(?:set|change|mark)\s+job\s+(.+?)\s+(?:as|to|status)\s+(.+)$/i);
  if (m) {
    return { intent: "change_job_status", entities: { job_title: m[1].trim(), job_status: m[2].trim() } };
  }

  m = text.match(/^convert\s+lead\s+(.+)$/i);
  if (m) {
    return { intent: "convert_lead", entities: { lead_name: m[1].trim() } };
  }

  m = text.match(/^assign\s+job\s+(.+?)\s+to\s+(.+)$/i);
  if (m) {
    return { intent: "assign_job", entities: { job_title: m[1].trim(), employee_name: m[2].trim() } };
  }

  if (/^(?:show|check)\s+overload$/i.test(text)) return { intent: "detect_overload", entities: {} };

  m = text.match(/^(?:create|add|new)\s+service\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    const category = extractLabelled(rest, "category");
    rest = category.rest;
    const name = rest.replace(/,\s*$/, "").trim();
    if (!name) return { intent: "unrecognized", entities: {} };
    return { intent: "create_service", entities: { name, category: category.value } };
  }

  m = text.match(/^(?:list|show)\s+quotes(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_quotes", entities: { client_name: m[1]?.trim() } };

  if (/^(?:list|show)\s+job\s+openings?$/i.test(text)) return { intent: "list_job_openings", entities: {} };

  m = text.match(/^when\s+i\s+say\s+(.+?)\s+i\s+mean\s+(.+)$/i);
  if (m) return { intent: "create_learning_rule", entities: { term: m[1].trim(), meaning: m[2].trim() } };

  m = text.match(/^(?:teach\s+me|remember)[:,]?\s+(.+?)\s+means\s+(.+)$/i);
  if (m) return { intent: "create_learning_rule", entities: { term: m[1].trim(), meaning: m[2].trim() } };

  if (/^(?:list|show)\s+learning\s+rules?$/i.test(text)) return { intent: "list_learning_rules", entities: {} };

  // "log call with Jane Smith: discussed timeline, promised quote by Friday"
  // "log email from Jane Smith: sent quote"
  // Channel word maps to a real COMMUNICATION_CHANNELS entry; direction is
  // inferred from "with"/"to" (outbound) vs "from" (inbound) — a reasonable
  // deterministic default the user can always correct via the form/API.
  m = text.match(
    /^log\s+(call|phone call|email|whatsapp|sms|text|messenger|message|meeting|visit)\s+(with|to|from)\s+(.+?)\s*:\s*(.+)$/i
  );
  if (m) {
    const channelWord = m[1].toLowerCase();
    const directionWord = m[2].toLowerCase();
    const clientName = m[3].trim();
    const summary = m[4].trim();
    const channelMap: Record<string, string> = {
      call: "phone_call",
      "phone call": "phone_call",
      email: "email",
      whatsapp: "whatsapp",
      sms: "sms",
      text: "sms",
      messenger: "messenger",
      message: "messenger",
      meeting: "in_person",
      visit: "in_person",
    };
    const channel = channelMap[channelWord] ?? "other";
    const direction = directionWord === "from" ? "inbound" : "outbound";
    if (!clientName || !summary) return { intent: "unrecognized", entities: {} };
    return { intent: "log_communication", entities: { client_name: clientName, channel, direction, summary } };
  }

  if (/^(?:list|show)\s+follow[\s-]?ups?$/i.test(text)) return { intent: "list_follow_ups", entities: {} };

  // Notification and Escalation Module — surfaces the unified attention
  // feed (overdue follow-ups, capacity overload, expiring quotes).
  if (/^(?:list|show)\s+notifications?$/i.test(text)) return { intent: "list_notifications", entities: {} };
  if (/^what\s+needs\s+attention\??$/i.test(text)) return { intent: "list_notifications", entities: {} };

  // Data Quality Engine — read-only, structural duplicate/missing-contact
  // analysis over real CRM Core client data.
  if (/^(?:list|show|check)\s+data\s+quality(?:\s+issues?)?$/i.test(text))
    return { intent: "list_data_quality", entities: {} };
  if (/^(?:list|show)\s+(?:possible\s+)?duplicate\s+clients?$/i.test(text))
    return { intent: "list_data_quality", entities: {} };

  m = text.match(/^(?:list|show)\s+communications?(?:\s+for\s+(.+))?$/i);
  if (m) return { intent: "list_communications", entities: { client_name: m[1]?.trim() } };

  if (/^(?:list|show)\s+clients?$/i.test(text)) return { intent: "list_clients", entities: {} };
  if (/^(?:list|show)\s+jobs?$/i.test(text)) return { intent: "list_jobs", entities: {} };
  if (/^(?:list|show)\s+leads?$/i.test(text)) return { intent: "list_leads", entities: {} };

  return { intent: "unrecognized", entities: {} };
}
