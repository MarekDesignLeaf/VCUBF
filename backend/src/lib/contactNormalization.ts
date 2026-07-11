export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// Normalise UK domestic and +44 forms to the same significant digits. A
// minimum length prevents placeholders from becoming identity evidence.
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("44") && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits.length >= 6 ? digits : null;
}

export function normalizeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}
