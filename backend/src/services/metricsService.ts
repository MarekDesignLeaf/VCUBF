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
  const durationMs = Math.max(1, to.getTime() - from.getTime());
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(previousTo.getTime() - durationMs);
  const previousCreatedAt = { gte: previousFrom, lte: previousTo };

  const [leads, quotes, jobs, employees, previousLeads, previousQuotes, previousJobs] = await Promise.all([
    prisma.lead.findMany({ where: { companyId: user.companyId, createdAt }, select: { leadStatus: true, source: true } }),
    prisma.quote.findMany({ where: { companyId: user.companyId, createdAt }, select: { quoteStatus: true, items: { select: { quantity: true, unitPrice: true, serviceCatalogueItem: { select: { id: true, name: true } } } } } }),
    prisma.job.findMany({ where: { companyId: user.companyId, createdAt }, select: { jobStatus: true } }),
    prisma.user.findMany({ where: { companyId: user.companyId, isActive: true }, select: { id: true } }),
    prisma.lead.findMany({ where: { companyId: user.companyId, createdAt: previousCreatedAt }, select: { leadStatus: true } }),
    prisma.quote.findMany({ where: { companyId: user.companyId, createdAt: previousCreatedAt }, select: { quoteStatus: true, items: { select: { quantity: true, unitPrice: true } } } }),
    prisma.job.findMany({ where: { companyId: user.companyId, createdAt: previousCreatedAt }, select: { jobStatus: true } }),
  ]);

  const leadSources = new Map<string, number>();
  for (const lead of leads) leadSources.set(lead.source?.trim() || "Unknown", (leadSources.get(lead.source?.trim() || "Unknown") ?? 0) + 1);
  const quoteDecisions = quotes.filter((quote) => ["accepted", "rejected", "expired"].includes(quote.quoteStatus));
  const acceptedQuotes = quoteDecisions.filter((quote) => quote.quoteStatus === "accepted").length;
  const quoteValues = quotes.map((quote) => quote.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  const previousQuoteDecisions = previousQuotes.filter((quote) => ["accepted", "rejected", "expired"].includes(quote.quoteStatus));
  const previousAcceptedQuotes = previousQuoteDecisions.filter((quote) => quote.quoteStatus === "accepted").length;
  const previousQuoteValues = previousQuotes.map((quote) => quote.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  const serviceRevenue = new Map<string, { serviceId: string; serviceName: string; acceptedValueGbp: number; lineCount: number }>();
  let unlinkedAcceptedValueGbp = 0;
  for (const quote of quotes.filter((value) => value.quoteStatus === "accepted")) {
    for (const item of quote.items) {
      const lineValue = item.quantity * item.unitPrice;
      if (!item.serviceCatalogueItem) { unlinkedAcceptedValueGbp += lineValue; continue; }
      const existing = serviceRevenue.get(item.serviceCatalogueItem.id) ?? { serviceId: item.serviceCatalogueItem.id, serviceName: item.serviceCatalogueItem.name, acceptedValueGbp: 0, lineCount: 0 };
      existing.acceptedValueGbp += lineValue;
      existing.lineCount += 1;
      serviceRevenue.set(existing.serviceId, existing);
    }
  }
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
    comparisonPeriod: { from: previousFrom.toISOString(), to: previousTo.toISOString() },
    trends: {
      newLeads: { current: leads.length, previous: previousLeads.length, delta: leads.length - previousLeads.length },
      quoteCount: { current: quotes.length, previous: previousQuotes.length, delta: quotes.length - previousQuotes.length },
      quoteConversionRatePct: { current: quoteDecisions.length ? Math.round((acceptedQuotes / quoteDecisions.length) * 1000) / 10 : null, previous: previousQuoteDecisions.length ? Math.round((previousAcceptedQuotes / previousQuoteDecisions.length) * 1000) / 10 : null },
      averageQuoteValueGbp: { current: quoteValues.length ? Math.round((quoteValues.reduce((a, b) => a + b, 0) / quoteValues.length) * 100) / 100 : null, previous: previousQuoteValues.length ? Math.round((previousQuoteValues.reduce((a, b) => a + b, 0) / previousQuoteValues.length) * 100) / 100 : null },
      completedJobs: { current: jobs.filter((job) => job.jobStatus === "dokonceno").length, previous: previousJobs.filter((job) => job.jobStatus === "dokonceno").length, delta: jobs.filter((job) => job.jobStatus === "dokonceno").length - previousJobs.filter((job) => job.jobStatus === "dokonceno").length },
    },
    leads: { newCount: leads.length, convertedCount: leads.filter((lead) => lead.leadStatus === "converted").length, lostCount: lostLeads, sources: [...leadSources.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)) },
    quotes: { count: quotes.length, decidedCount: quoteDecisions.length, acceptedCount: acceptedQuotes, conversionRatePct: quoteDecisions.length ? Math.round((acceptedQuotes / quoteDecisions.length) * 1000) / 10 : null, averageValueGbp: quoteValues.length ? Math.round((quoteValues.reduce((a, b) => a + b, 0) / quoteValues.length) * 100) / 100 : null },
    jobs: { acceptedCount: jobs.filter((job) => ["prijato", "naplanovano", "v_realizaci", "dokonceno"].includes(job.jobStatus)).length, completedCount: jobs.filter((job) => job.jobStatus === "dokonceno").length, cancelledCount: jobs.filter((job) => job.jobStatus === "zruseno").length, lostDueToAvailability: unavailable("Jobs do not currently record a cancellation reason.") },
    revenueByService: { rows: [...serviceRevenue.values()].map((row) => ({ ...row, acceptedValueGbp: Math.round(row.acceptedValueGbp * 100) / 100 })).sort((a, b) => b.acceptedValueGbp - a.acceptedValueGbp || a.serviceName.localeCompare(b.serviceName)), unlinkedAcceptedValueGbp: Math.round(unlinkedAcceptedValueGbp * 100) / 100, basis: "Accepted quote line value, not recognized accounting revenue." },
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
