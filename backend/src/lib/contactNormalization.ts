import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { z } from "zod";

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export const PHONE_VALIDATION_MESSAGE =
  "Enter a valid UK or international phone number, for example 07700 900123 or +44 7700 900123";

const PHONE_CHARACTERS = /^\+?[0-9\s().-]+$/;
const UK_OFCOM_DRAMA_MOBILE = /^7700900\d{3}$/;

// UK national numbers are accepted because Secretary currently serves UK
// businesses. An explicit country calling code supports every other country.
// isValid() verifies country-specific length and number ranges. Ofcom's
// reserved 07700 900xxx range is also accepted so examples and automated tests
// never need to use a real person's number. Neither check proves reachability
// or ownership.
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const input = phone.trim();
  if (!input || input.length > 40 || !PHONE_CHARACTERS.test(input)) return null;
  const parsed = parsePhoneNumberFromString(input, "GB");
  if (!parsed) return null;
  const isReservedUkExample =
    parsed.country === "GB" && parsed.isPossible() && UK_OFCOM_DRAMA_MOBILE.test(parsed.nationalNumber);
  return parsed.isValid() || isReservedUkExample ? parsed.number : null;
}

export function isValidPhoneNumberFormat(phone: string | null | undefined): phone is string {
  return normalizePhone(phone) !== null;
}

export const phoneNumberSchema = z
  .string()
  .trim()
  .min(1, PHONE_VALIDATION_MESSAGE)
  .max(40, PHONE_VALIDATION_MESSAGE)
  .refine(isValidPhoneNumberFormat, PHONE_VALIDATION_MESSAGE)
  .transform((phone) => normalizePhone(phone)!);

export function normalizeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}
