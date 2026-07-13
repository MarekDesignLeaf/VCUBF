import { z } from "zod";
import { prisma } from "../db.js";
import {
  ARCHIVE_ASSISTANT_MEMORY_ACTION,
  ASSISTANT_MEMORY_SCOPES,
  ASSISTANT_MEMORY_STATUSES,
  CREATE_ASSISTANT_MEMORY_ACTION,
  RECALL_ASSISTANT_MEMORY_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const createAssistantMemorySchema = z.object({
  content: z.string().trim().min(1, "content is required").max(2000),
  scope: z.enum(ASSISTANT_MEMORY_SCOPES).default("personal"),
});

export const listAssistantMemoriesSchema = z.object({
  status: z.enum([...ASSISTANT_MEMORY_STATUSES, "all"] as const).default("active"),
  query: z.string().trim().max(200).optional(),
});

export interface AssistantMemoryView {
  id: string;
  scope: "personal" | "company";
  content: string;
  status: "active" | "archived";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface AssistantContext {
  persistentMemories: Array<Pick<AssistantMemoryView, "id" | "scope" | "content" | "updatedAt">>;
  recentConversations: Array<{
    id: string;
    endedAt: Date | null;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }>;
}

function normalizeContent(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function publicMemory(memory: any): AssistantMemoryView {
  return {
    id: memory.id,
    scope: memory.scope,
    content: memory.content,
    status: memory.status,
    createdBy: memory.createdBy,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    archivedAt: memory.archivedAt,
  };
}

function visibleMemoryWhere(user: AuthedUser) {
  return {
    companyId: user.companyId,
    OR: [{ scope: "company" }, { scope: "personal", ownerUserId: user.id }],
  };
}

function canManageCompanyMemory(user: AuthedUser): boolean {
  return user.permissions.includes("crm.manage");
}

export async function listAssistantMemories(
  user: AuthedUser,
  rawFilters: unknown = {}
): Promise<AssistantMemoryView[]> {
  const filters = listAssistantMemoriesSchema.parse(rawFilters);
  const rows = await prisma.assistantMemory.findMany({
    where: {
      ...visibleMemoryWhere(user),
      ...(filters.status === "all" ? {} : { status: filters.status }),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  const query = filters.query ? normalizeContent(filters.query) : "";
  const filtered = query
    ? rows.filter((row) => row.normalizedContent.includes(query) || query.includes(row.normalizedContent))
    : rows;
  return filtered.map(publicMemory);
}

export async function createAssistantMemory(
  user: AuthedUser,
  rawInput: unknown
): Promise<ServiceResult<AssistantMemoryView & { duplicate: boolean }>> {
  const parsed = createAssistantMemorySchema.safeParse(rawInput);
  if (!parsed.success) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_ASSISTANT_MEMORY_ACTION.actionName,
      inputPayload: rawInput,
      riskLevel: CREATE_ASSISTANT_MEMORY_ACTION.riskLevel,
      confirmationRequired: false,
      result: "error",
      errorMessage: "VALIDATION_FAILED",
    });
    return fail(400, "VALIDATION_FAILED", parsed.error.message);
  }
  const input = parsed.data;
  if (input.scope === "company" && !canManageCompanyMemory(user)) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: CREATE_ASSISTANT_MEMORY_ACTION.actionName,
      inputPayload: input,
      riskLevel: CREATE_ASSISTANT_MEMORY_ACTION.riskLevel,
      confirmationRequired: false,
      result: "rejected",
      errorMessage: "MISSING_PERMISSION",
    });
    return fail(403, "MISSING_PERMISSION", "Company memory requires crm.manage permission.");
  }

  const normalizedContent = normalizeContent(input.content);
  const ownerUserId = input.scope === "personal" ? user.id : null;
  const existing = await prisma.assistantMemory.findFirst({
    where: {
      companyId: user.companyId,
      scope: input.scope,
      ownerUserId,
      normalizedContent,
      status: "active",
    },
  });
  if (existing) return ok(200, { ...publicMemory(existing), duplicate: true });

  const created = await prisma.assistantMemory.create({
    data: {
      companyId: user.companyId,
      ownerUserId,
      scope: input.scope,
      content: input.content,
      normalizedContent,
      createdBy: user.id,
    },
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CREATE_ASSISTANT_MEMORY_ACTION.actionName,
    interpretedIntent: input.scope,
    inputPayload: input,
    dataAfter: publicMemory(created),
    riskLevel: CREATE_ASSISTANT_MEMORY_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });
  return ok(201, { ...publicMemory(created), duplicate: false });
}

export async function recallAssistantMemories(user: AuthedUser, query?: string): Promise<AssistantMemoryView[]> {
  const memories = await listAssistantMemories(user, { status: "active", query });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: RECALL_ASSISTANT_MEMORY_ACTION.actionName,
    interpretedIntent: query ? "filtered" : "all",
    inputPayload: { query },
    dataAfter: { count: memories.length },
    riskLevel: RECALL_ASSISTANT_MEMORY_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });
  return memories.slice(0, 10);
}

export async function archiveAssistantMemory(
  user: AuthedUser,
  id: string
): Promise<ServiceResult<AssistantMemoryView>> {
  const existing = await prisma.assistantMemory.findFirst({ where: { id, companyId: user.companyId } });
  const canArchive = existing && (
    (existing.scope === "personal" && existing.ownerUserId === user.id) ||
    (existing.scope === "company" && canManageCompanyMemory(user))
  );
  if (!canArchive) {
    return fail(404, "ASSISTANT_MEMORY_NOT_FOUND");
  }
  const updated = await prisma.assistantMemory.update({
    where: { id: existing.id },
    data: { status: "archived", archivedAt: new Date() },
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: ARCHIVE_ASSISTANT_MEMORY_ACTION.actionName,
    interpretedIntent: existing.scope,
    inputPayload: { id },
    dataBefore: publicMemory(existing),
    dataAfter: publicMemory(updated),
    riskLevel: ARCHIVE_ASSISTANT_MEMORY_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });
  return ok(200, publicMemory(updated));
}

function truncateContext(text: string, remaining: number): string {
  if (remaining <= 0) return "";
  return text.length <= remaining ? text : `${text.slice(0, Math.max(0, remaining - 1))}…`;
}

export async function getAssistantContext(user: AuthedUser): Promise<AssistantContext> {
  const memories = await listAssistantMemories(user, { status: "active" });
  let memoryBudget = 8000;
  const persistentMemories: AssistantContext["persistentMemories"] = [];
  for (const memory of memories.slice(0, 20)) {
    const content = truncateContext(memory.content, memoryBudget);
    if (!content) break;
    persistentMemories.push({ id: memory.id, scope: memory.scope, content, updatedAt: memory.updatedAt });
    memoryBudget -= content.length;
  }

  const conversations = await prisma.voiceConversation.findMany({
    where: {
      companyId: user.companyId,
      userId: user.id,
      status: { in: ["completed", "interrupted"] },
      endedAt: { not: null },
    },
    orderBy: { startedAt: "desc" },
    take: 3,
    include: { messages: { orderBy: { sequence: "desc" }, take: 8 } },
  });
  let conversationBudget = 6000;
  const recentConversations: AssistantContext["recentConversations"] = [];
  for (const conversation of conversations) {
    const messages: AssistantContext["recentConversations"][number]["messages"] = [];
    for (const message of [...conversation.messages].reverse()) {
      const content = truncateContext(message.content, conversationBudget);
      if (!content) break;
      if (message.role === "user" || message.role === "assistant") {
        messages.push({ role: message.role, content });
        conversationBudget -= content.length;
      }
    }
    if (messages.length) recentConversations.push({ id: conversation.id, endedAt: conversation.endedAt, messages });
    if (conversationBudget <= 0) break;
  }
  return { persistentMemories, recentConversations };
}
