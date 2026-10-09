/**
 * The deployed build: the commit Railway built this backend from (GitHub's in
 * CI, "local" elsewhere), shortened to 12 characters. Reported by /health and
 * recorded on agent runs, where it marks the code a measurement was made with.
 */
export function buildId(): string {
  return (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local").slice(0, 12);
}
