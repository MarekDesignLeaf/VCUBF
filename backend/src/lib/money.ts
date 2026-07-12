import { z } from "zod";

export const MAX_MONEY = 999_999_999_999.99;

const hasAtMostTwoDecimalPlaces = (value: number) =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;

const boundedMoney = z.number().finite().max(MAX_MONEY, `amount must not exceed ${MAX_MONEY}`);

export const nonnegativeMoney = boundedMoney.nonnegative()
  .refine(hasAtMostTwoDecimalPlaces, "amount must have at most two decimal places");
export const positiveMoney = boundedMoney.positive()
  .refine(hasAtMostTwoDecimalPlaces, "amount must have at most two decimal places");

export const moneyLinesFit = (lines: readonly { quantity: number; unitAmount: number }[]) => {
  let total = 0;
  for (const line of lines) {
    const lineTotal = line.quantity * line.unitAmount;
    if (!Number.isFinite(lineTotal) || lineTotal > MAX_MONEY) return false;
    total += lineTotal;
    if (!Number.isFinite(total) || total > MAX_MONEY) return false;
  }
  return true;
};
