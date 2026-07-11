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

function coverage(complete: number, total: number) {
  return { complete, total, pct: total ? Math.round((complete / total) * 1000) / 10 : null };
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
    prisma.lead.findMany({ where: { companyId: user.companyId, createdAt }, select: { leadStatus: true, source: true, serviceRequested: true } }),
    prisma.quote.findMany({ where: { companyId: user.companyId, createdAt }, select: { quoteStatus: true, items: { select: { quantity: true, unitPrice: true, unitCost: true, serviceCatalogueItem: { select: { id: true, name: true } } } } } }),
    prisma.job.findMany({ where: { companyId: user.companyId, createdAt }, select: { jobStatus: true, estimatedDurationHours: true, plannedStartAt: true, serviceCatalogueItemId: true } }),
    prisma.user.findMany({ where: { companyId: user.companyId, isActive: true }, select: { id: true } }),
    prisma.lead.findMany({ where: { companyId: user.companyId, createdAt: previousCreatedAt }, select: { leadStatus: true, serviceRequested: true } }),
    prisma.quote.findMany({ where: { companyId: user.companyId, createdAt: previousCreatedAt }, select: { quoteStatus: true, items: { select: { quantity: true, unitPrice: true } } } }),
    prisma.job.findMany({ where: { companyId: user.companyId, createdAt: previousCreatedAt }, select: { jobStatus: true } }),
  ]);

  const leadSources = new Map<string, { source: string; count: number; convertedCount: number; lostCount: number }>();
  for (const lead of leads) {
    const source = lead.source?.trim() || "Unknown";
    const row = leadSources.get(source) ?? { source, count: 0, convertedCount: 0, lostCount: 0 };
    row.count += 1;
    if (lead.leadStatus === "converted") row.convertedCount += 1;
    if (lead.leadStatus === "lost") row.lostCount += 1;
    leadSources.set(source, row);
  }
  const quoteDecisions = quotes.filter((quote) => ["accepted", "rejected", "expired"].includes(quote.quoteStatus));
  const acceptedQuotes = quoteDecisions.filter((quote) => quote.quoteStatus === "accepted").length;
  const quoteValues = quotes.map((quote) => quote.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  const demand = new Map<string, { serviceRequested: string; current: number; previous: number }>();
  for (const lead of leads) {
    const label = lead.serviceRequested?.trim();
    if (!label) continue;
    const key = label.toLocaleLowerCase("en-GB");
    const row = demand.get(key) ?? { serviceRequested: label, current: 0, previous: 0 };
    row.current += 1;
    demand.set(key, row);
  }
  for (const lead of previousLeads) {
    const label = lead.serviceRequested?.trim();
    if (!label) continue;
    const key = label.toLocaleLowerCase("en-GB");
    const row = demand.get(key) ?? { serviceRequested: label, current: 0, previous: 0 };
    row.previous += 1;
    demand.set(key, row);
  }
  const serviceDemand = [...demand.values()].map((row) => ({ ...row, delta: row.current - row.previous })).sort((a, b) => b.current - a.current || b.delta - a.delta || a.serviceRequested.localeCompare(b.serviceRequested));
  const quoteItems = quotes.flatMap((quote) => quote.items);
  const activePeriodJobs = jobs.filter((job) => !["dokonceno", "zruseno"].includes(job.jobStatus));
  const dataCompleteness = {
    leadSource: coverage(leads.filter((lead) => Boolean(lead.source?.trim())).length, leads.length),
    quoteServiceLink: coverage(quoteItems.filter((item) => Boolean(item.serviceCatalogueItem)).length, quoteItems.length),
    quoteCost: coverage(quoteItems.filter((item) => item.unitCost != null).length, quoteItems.length),
    activeJobEstimate: coverage(activePeriodJobs.filter((job) => job.estimatedDurationHours != null).length, activePeriodJobs.length),
    activeJobPlannedDate: coverage(activePeriodJobs.filter((job) => job.plannedStartAt != null).length, activePeriodJobs.length),
    activeJobServiceLink: coverage(activePeriodJobs.filter((job) => job.serviceCatalogueItemId != null).length, activePeriodJobs.length),
  };
  const previousQuoteDecisions = previousQuotes.filter((quote) => ["accepted", "rejected", "expired"].includes(quote.quoteStatus));
  const previousAcceptedQuotes = previousQuoteDecisions.filter((quote) => quote.quoteStatus === "accepted").length;
  const previousQuoteValues = previousQuotes.map((quote) => quote.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  const serviceRevenue = new Map<string, { serviceId: string; serviceName: string; acceptedValueGbp: number; knownCostGbp: number; lineCount: number; linesWithKnownCost: number }>();
  let unlinkedAcceptedValueGbp = 0;
  for (const quote of quotes.filter((value) => value.quoteStatus === "accepted")) {
    for (const item of quote.items) {
      const lineValue = item.quantity * item.unitPrice;
      if (!item.serviceCatalogueItem) { unlinkedAcceptedValueGbp += lineValue; continue; }
      const existing = serviceRevenue.get(item.serviceCatalogueItem.id) ?? { serviceId: item.serviceCatalogueItem.id, serviceName: item.serviceCatalogueItem.name, acceptedValueGbp: 0, knownCostGbp: 0, lineCount: 0, linesWithKnownCost: 0 };
      existing.acceptedValueGbp += lineValue;
      existing.lineCount += 1;
      if (item.unitCost != null) {
        existing.knownCostGbp += item.quantity * item.unitCost;
        existing.linesWithKnownCost += 1;
      }
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
  for (const source of leadSources.values()) {
    if (source.count >= 3 && source.lostCount / source.count >= 0.5) recommendations.push({ severity: "warning", title: `Lead source needs review: ${source.source}`, evidence: `${source.lostCount} of ${source.count} leads from this source are marked lost; ${source.convertedCount} are converted.`, action: "Review this source's lead quality and follow-up evidence before reducing or increasing spend." });
  }
  for (const service of serviceDemand) {
    if (service.current >= 3 && service.delta >= 2) recommendations.push({ severity: "info", title: `Demand is increasing: ${service.serviceRequested}`, evidence: `${service.current} leads requested this exact service label in the selected period versus ${service.previous} previously.`, action: "Review capacity, catalogue coverage and lead outcomes for this demand before changing staffing, price or marketing." });
  }
  const completenessChecks: { label: string; metric: { complete: number; total: number; pct: number | null }; action: string }[] = [
    { label: "Quote cost coverage", metric: dataCompleteness.quoteCost, action: "Enter real unit costs on quote lines before relying on margin reporting." },
    { label: "Quote service-link coverage", metric: dataCompleteness.quoteServiceLink, action: "Link quote lines to catalogue services where the relationship is known." },
    { label: "Active-job estimate coverage", metric: dataCompleteness.activeJobEstimate, action: "Add duration estimates to active jobs so capacity calculations can count them." },
    { label: "Active-job planned-date coverage", metric: dataCompleteness.activeJobPlannedDate, action: "Add real planned dates before relying on weekly workload figures." },
  ];
  for (const check of completenessChecks) {
    if (check.metric.total >= 3 && check.metric.pct != null && check.metric.pct < 80) recommendations.push({ severity: "warning", title: `${check.label} is below 80%`, evidence: `${check.metric.complete} of ${check.metric.total} relevant records are complete (${check.metric.pct}%).`, action: check.action });
  }
  if (quoteDecisions.length >= 3 && acceptedQuotes / quoteDecisions.length < 0.4) recommendations.push({ severity: "warning", title: "Quote conversion is below 40%", evidence: `${acceptedQuotes} of ${quoteDecisions.length} decided quotes were accepted.`, action: "Review rejected and expired quotes and follow-up timing; do not change prices without evidence." });
  if (utilization != null && utilization >= 85) recommendations.push({ severity: "warning", title: "Current team capacity is tight", evidence: `${totalLoad} of ${totalCapacity} entered hours are allocated this week (${utilization}%).`, action: "Review scheduling, subcontracting or recruitment capacity before accepting urgent dates." });
  if (recommendations.length === 0) recommendations.push({ severity: "info", title: "No threshold-based issue detected", evidence: `Analysis used ${leads.length} leads, ${quotes.length} quotes and ${jobs.length} jobs in the selected period.`, action: "Keep collecting complete source, status, price, cost and duration data to improve decisions." });

  return {
    period: { from: from.toISOString(), to: to.toISOString(), days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000)) },
    comparisonPeriod: { from: previousFrom.toISOString(), to: previousTo.toISOString() },
    dataCompleteness,
    serviceDemand: { rows: serviceDemand, unclassifiedLeadCount: leads.filter((lead) => !lead.serviceRequested?.trim()).length, basis: "Exact normalized lead service_requested text; no automatic catalogue mapping." },
    trends: {
      newLeads: { current: leads.length, previous: previousLeads.length, delta: leads.length - previousLeads.length },
      quoteCount: { current: quotes.length, previous: previousQuotes.length, delta: quotes.length - previousQuotes.length },
      quoteConversionRatePct: { current: quoteDecisions.length ? Math.round((acceptedQuotes / quoteDecisions.length) * 1000) / 10 : null, previous: previousQuoteDecisions.length ? Math.round((previousAcceptedQuotes / previousQuoteDecisions.length) * 1000) / 10 : null },
      averageQuoteValueGbp: { current: quoteValues.length ? Math.round((quoteValues.reduce((a, b) => a + b, 0) / quoteValues.length) * 100) / 100 : null, previous: previousQuoteValues.length ? Math.round((previousQuoteValues.reduce((a, b) => a + b, 0) / previousQuoteValues.length) * 100) / 100 : null },
      completedJobs: { current: jobs.filter((job) => job.jobStatus === "dokonceno").length, previous: previousJobs.filter((job) => job.jobStatus === "dokonceno").length, delta: jobs.filter((job) => job.jobStatus === "dokonceno").length - previousJobs.filter((job) => job.jobStatus === "dokonceno").length },
    },
    leads: { newCount: leads.length, convertedCount: leads.filter((lead) => lead.leadStatus === "converted").length, lostCount: lostLeads, sources: [...leadSources.values()].map((row) => ({ ...row, conversionRatePct: row.count ? Math.round((row.convertedCount / row.count) * 1000) / 10 : null, lossRatePct: row.count ? Math.round((row.lostCount / row.count) * 1000) / 10 : null })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)) },
    quotes: { count: quotes.length, decidedCount: quoteDecisions.length, acceptedCount: acceptedQuotes, conversionRatePct: quoteDecisions.length ? Math.round((acceptedQuotes / quoteDecisions.length) * 1000) / 10 : null, averageValueGbp: quoteValues.length ? Math.round((quoteValues.reduce((a, b) => a + b, 0) / quoteValues.length) * 100) / 100 : null },
    jobs: { acceptedCount: jobs.filter((job) => ["prijato", "naplanovano", "v_realizaci", "dokonceno"].includes(job.jobStatus)).length, completedCount: jobs.filter((job) => job.jobStatus === "dokonceno").length, cancelledCount: jobs.filter((job) => job.jobStatus === "zruseno").length, lostDueToAvailability: unavailable("Jobs do not currently record a cancellation reason.") },
    revenueByService: { rows: [...serviceRevenue.values()].map((row) => { const costKnown = row.linesWithKnownCost === row.lineCount; const margin = costKnown ? row.acceptedValueGbp - row.knownCostGbp : null; return { serviceId: row.serviceId, serviceName: row.serviceName, acceptedValueGbp: Math.round(row.acceptedValueGbp * 100) / 100, lineCount: row.lineCount, linesWithKnownCost: row.linesWithKnownCost, costKnown, marginGbp: margin == null ? null : Math.round(margin * 100) / 100, marginPct: margin == null || row.acceptedValueGbp === 0 ? (margin === 0 ? 0 : null) : Math.round((margin / row.acceptedValueGbp) * 1000) / 10 }; }).sort((a, b) => b.acceptedValueGbp - a.acceptedValueGbp || a.serviceName.localeCompare(b.serviceName)), unlinkedAcceptedValueGbp: Math.round(unlinkedAcceptedValueGbp * 100) / 100, basis: "Accepted quote line value, not recognized accounting revenue. Margin is available only when every included line has an entered unit cost." },
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
