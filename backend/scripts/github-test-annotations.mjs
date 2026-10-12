// A Node test-runner reporter that turns each failed test into a GitHub
// Actions error annotation. A failure is then readable in the pull request's
// checks (and through the check-runs API) without opening the raw job log,
// which is served from another host than the API. Outside GitHub Actions it
// stays silent.

import path from "node:path";

function property(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function data(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export default async function* githubTestAnnotations(source) {
  const annotate = Boolean(process.env.GITHUB_ACTIONS);
  for await (const event of source) {
    if (!annotate || event.type !== "test:fail") continue;
    const { name, details, file, line } = event.data;
    const error = details?.error;
    // The runner wraps the assertion; its cause carries the expected/actual diff.
    const cause = error?.cause ?? error;
    if (error?.failureType === "subtestsFailed") continue;
    const message = (cause?.message ?? String(cause ?? "failed")).slice(0, 4000);
    const where = file ? `file=${property(path.relative(process.cwd(), file.replace(/^file:\/\//, "")))},line=${line ?? 1},` : "";
    yield `::error ${where}title=${property(name)}::${data(message)}\n`;
  }
}
