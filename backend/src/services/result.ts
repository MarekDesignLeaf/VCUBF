// Uniform result shape used by every service function so both REST routes and
// the Voice/Text Command Layer can call the same business logic and get a
// consistent, structured outcome — never a bare throw, never a guess.
export type ServiceResult<T> =
  | { ok: true; httpStatus: number; data: T }
  | { ok: false; httpStatus: number; error: string; message?: string; extra?: Record<string, unknown> };

export function ok<T>(httpStatus: number, data: T): ServiceResult<T> {
  return { ok: true, httpStatus, data };
}

export function fail(
  httpStatus: number,
  error: string,
  message?: string,
  extra?: Record<string, unknown>
): Extract<ServiceResult<never>, { ok: false }> {
  return { ok: false, httpStatus, error, message, extra };
}
