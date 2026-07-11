import { z } from "zod";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import { computeEmployeeCapacity } from "./capacityService.js";

export const metricsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).refine((value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to), { message: "from must be before to" });

function unavailable(reason: string) {
  return { available: false as const, value: null, reason };
}

export async function getMetricsOverview(user: AuthedUser, input: z.infer<typeof metricsQuerySchema>) {
  const to = input.to ? new Date(input.to) : new Date();
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const createdAt = { gte: from, lte: to };

  const [leads, quotes, jobs, employees] = await Promise.all([
    prisma.lead.findMany({ where: { companyId: user.companyId, createdAt }, select: { leadStatus: true, source: true } }),
    prisma.quote.findMany({ where: { companyId: user.companyId, createdAt }, select: { quoteStatus: true, items: { select: { quantity: true, unitPrice: true } } } }),
    prisma.job.findMany({ where: { companyId: user.companyId, createdAt }, select: { jobStatus: true } }),
    prisma.user.findMany({ where: { companyId: user.companyId, isActive: true }, select: { id: true } }),
  ]);

  const leadSources = new Map<string, number>();
  for (const lead of leads) leadSources.set(lead.source?.trim() || "Unknown", (leadSources.get(lead.source?.trim() || "Unknown") ?? 0) + 1);
  const quoteDecisions = quotes.filter((quote) => ["accepted", "rejected", "expired"].includes(quote.quoteStatus));
  const acceptedQuotes = quoteDecisions.filter((quote) => quote.quoteStatus === "accepted").length;
  const quoteValues = quotes.map((quote) => quote.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  const capacities = (await Promise.all(employees.map((employee) => computeEmployeeCapacity(user, employee.id, to)))).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const totalCapacity = capacities.reduce((sum, value) => sum + value.weeklyCapacityHours, 0);
  const totalLoad = capacities.reduce((sum, value) => sum + value.currentLoadHours, 0);
  const missingCapacityEstimates = capacities.reduce((sum, value) => sum + value.jobsMissingEstimate + value.tasksMissingEstimate, 0);
  const utilization = totalCapacity > 0 ? Math.round((totalLoad / totalCapacity) * 100) : null;

  const recommendations: { severity: "info" | "warning"; title: string; evidence: string; action: string }[] = [];
  const lostLeads = leads.filter((lead) => lead.leadStatus === "lost").length;
  if (leads.length >= 5 && lostLeads / leads.length >= 0.3) recommendations.push({ severity: "warning", title: "Lead loss is elevated", evidence: `${lostLeads} of ${leads.length} new leads in the selected period are marked lost.`, action: "Review lost-lead notes and source quality before changing marketing or pricing." });
  if (quoteDecisions.length >= 3 && acceptedQuotes / quoteDecisions.length < 0.4) recommendations.push({ severity: "warning", title: "Quote conversion is below 40%", evidence: `${acceptedQuotes} of ${quoteDecisions.length} decided quotes were accepted.`, action: "Review rejected and expired quotes and follow-up timing; do not change prices without evidence." });
  if (utilization != null && utilization >= 85) recommendations.push({ severity: "warning", title: "Current team capacity is tight", evidence: `${totalLoad} of ${totalCapacity} entered hours are allocated this week (${utilization}%).`, action: "Review scheduling, subcontracting or recruitment capacity before accepting urgent dates." });
  if (recommendations.length === 0) recommendations.push({ severity: "info", title: "No threshold-based issue detected", evidence: `Analysis used ${leads.length} leads, ${quotes.length} quotes and ${jobs.length} jobs in the selected period.`, action: "Keep collecting complete source, status, price, cost and duration data to improve decisions." });

  return {
    period: { from: from.toISOString(), to: to.toISOString(), days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000)) },
    leads: { newCount: leads.length, convertedCount: leads.filter((lead) => lead.leadStatus === "converted").length, lostCount: lostLeads, sources: [...leadSources.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)) },
    quotes: { count: quotes.length, decidedCount: quoteDecisions.length, acceptedCount: acceptedQuotes, conversionRatePct: quoteDecisions.length ? Math.round((acceptedQuotes / quoteDecisions.length) * 1000) / 10 : null, averageValueGbp: quoteValues.length ? Math.round((quoteValues.reduce((a, b) => a + b, 0) / quoteValues.length) * 100) / 100 : null },
    jobs: { acceptedCount: jobs.filter((job) => ["prijato", "naplanovano", "v_realizaci", "dokonceno"].includes(job.jobStatus)).length, completedCount: jobs.filter((job) => job.jobStatus === "dokonceno").length, cancelledCount: jobs.filter((job) => job.jobStatus === "zruseno").length, lostDueToAvailability: unavailable("Jobs do not currently record a cancellation reason.") },
    capacity: totalCapacity > 0 ? { available: true as const, weekStart: capacities[0]?.weekStart ?? null, weekEnd: capacities[0]?.weekEnd ?? null, loadHours: totalLoad, capacityHours: totalCapacity, utilizationPct: utilization, overloadedEmployees: capacities.filter((value) => value.overloaded).length, missingEstimates: missingCapacityEstimates } : unavailable("No active employee has entered weekly capacity."),
    unavailableMetrics: {
      responseTime: "No reliable inbound-to-first-response link is stored.",
      firstAvailableDateWait: "Jobs do not store enquiry date and offered-date history.",
      jobProfitability: "Quotes contain costs, but completed-job revenue/cost attribution is not stored.",
      clientSatisfaction: "No satisfaction or review records exist.",
      unpaidInvoices: "No invoice/payment module exists.",
      websiteAndSocialActivity: "No verified analytics connector exists.",
    },
    recommendations,
  };
}
