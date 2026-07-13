import { z } from "zod";
import { PROGRAM_KNOWLEDGE } from "../lib/programKnowledge.js";

const assistantResultSchema = z.object({
  kind: z.enum(["command", "reply", "clarification", "plan"]),
  canonical_command: z.string().nullable(),
  message: z.string().min(1).max(800),
});

export type VoiceAssistantResult = z.infer<typeof assistantResultSchema>;

export interface RealtimeClientSession {
  clientSecret: string;
  expiresAt?: number;
  model: string;
}

const supportedCommands = `
create client NAME, email EMAIL, phone PHONE
create lead NAME for SERVICE, email EMAIL, phone PHONE
create job JOB TITLE for CLIENT NAME
set job JOB TITLE as STATUS
convert lead LEAD NAME
assign job JOB TITLE to EMPLOYEE NAME
show overload
create task for EMPLOYEE NAME: TITLE
create task TITLE, assigned to EMPLOYEE NAME, due ISO DATE
list tasks
create service NAME, category CATEGORY
list quotes [for CLIENT NAME]
list job openings
when I say TERM I mean MEANING
list learning rules
log call|email|meeting with|to|from CLIENT: SUMMARY
list communications [for CLIENT NAME]
log photo FILENAME [for CLIENT NAME]: CAPTION
list photos [for CLIENT NAME]
list marketing photos
list follow ups
list unresolved enquiries [from the last N days]
list notifications
show data quality issues
show action patterns
list clients
list jobs
list leads`.trim();

function outputText(payload: any): string | undefined {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return undefined;
}

export async function interpretVoiceRequest(input: {
  text: string;
  userName: string;
  language: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<VoiceAssistantResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_NOT_CONFIGURED");

  const model = process.env.OPENAI_VOICE_MODEL ?? "gpt-5-mini";
  const history = (input.history ?? []).slice(-6);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      instructions: `You are Emma, the concise voice interface for a business operating system.
Reply in the user's language (${input.language}). Address the user naturally when useful; their name is ${input.userName}.
Never claim an action happened unless kind is command and the backend later confirms it.
Never invent company data. Never turn legal, financial, deletion, publishing, hiring, payment, invoice sending, or other risky requests into a command. For those, explain that a reviewed confirmation flow is required.
If the request maps unambiguously to exactly one supported command, return kind command and rewrite it into one exact canonical form below. Preserve names and values exactly. Do not add missing facts.
If a required value is missing or ambiguous, return clarification and ask one short question.
If it is a complex objective, return plan with a short numbered spoken plan and identify facts or approvals needed. Do not execute it.
If it is conversation or a capability question, return reply. Be brief and honest.

Supported canonical commands:
${supportedCommands}

Use this implemented application map when the user asks how to do something, where a feature is, what a page means, or how to reach an outcome. Guide step by step and never invent UI:
${PROGRAM_KNOWLEDGE}`,
      input: [...history, { role: "user", content: input.text }],
      text: {
        format: {
          type: "json_schema",
          name: "emma_voice_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "canonical_command", "message"],
            properties: {
              kind: { type: "string", enum: ["command", "reply", "clarification", "plan"] },
              canonical_command: { type: ["string", "null"] },
              message: { type: "string" },
            },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new Error(`OPENAI_REQUEST_FAILED_${response.status}`);
  const raw = outputText(await response.json());
  if (!raw) throw new Error("OPENAI_EMPTY_RESPONSE");
  return assistantResultSchema.parse(JSON.parse(raw));
}

export async function createRealtimeClientSession(): Promise<RealtimeClientSession> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_NOT_CONFIGURED");
  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-1.5";
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        audio: { output: { voice: process.env.OPENAI_REALTIME_VOICE ?? "marin" } },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OPENAI_REALTIME_SESSION_FAILED_${response.status}`);
  const payload: any = await response.json();
  const clientSecret = payload?.value ?? payload?.client_secret?.value;
  if (typeof clientSecret !== "string" || !clientSecret) throw new Error("OPENAI_REALTIME_SECRET_MISSING");
  return {
    clientSecret,
    expiresAt: payload?.expires_at ?? payload?.client_secret?.expires_at,
    model: payload?.session?.model ?? payload?.model ?? model,
  };
}
