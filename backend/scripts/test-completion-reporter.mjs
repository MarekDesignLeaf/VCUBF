// A Node test-runner reporter that proves a test file ran to the end.
//
// `node --test <file>` runs the file in a child process and reads its results
// back over a pipe. If that child exits before the pipe is drained (as
// `--test-force-exit` did on Node 22), the parent only sees the events that
// arrived, prints a smaller summary with `fail 0` and exits 0: tests that
// never ran look like a pass.
//
// The child's last event is its own `test:summary` (one carrying `file`).
// Events arrive in order, so receiving it means every earlier event arrived
// too. This reporter writes a JSON verdict to its destination;
// scripts/run-test-files.mjs reads it and fails the run when the file did not
// complete.

export default async function* testCompletion(source) {
  let fileSummary = null;
  let finalSummary = null;
  const enqueued = new Map();
  const completed = new Map();
  let started = 0;
  let finished = 0;
  for await (const event of source) {
    const nesting = event.data?.nesting ?? 0;
    switch (event.type) {
      case "test:enqueue":
        enqueued.set(nesting, (enqueued.get(nesting) ?? 0) + 1);
        break;
      case "test:complete":
        completed.set(nesting, (completed.get(nesting) ?? 0) + 1);
        break;
      case "test:start":
        started += 1;
        break;
      case "test:pass":
      case "test:fail":
        finished += 1;
        break;
      case "test:summary":
        if (event.data.file) fileSummary = event.data;
        else finalSummary = event.data;
        break;
      default:
        break;
    }
  }

  const problems = [];
  if (!fileSummary) problems.push("the test file's own summary never arrived: its process ended before reporting every test");
  if (!finalSummary) problems.push("the run's final summary never arrived");
  if (started !== finished) problems.push(`${started} tests started but only ${finished} reported a result`);
  for (const [nesting, count] of enqueued) {
    const done = completed.get(nesting) ?? 0;
    if (done !== count) problems.push(`${count} tests queued at depth ${nesting} but ${done} completed`);
  }
  if (fileSummary && finalSummary && fileSummary.counts.tests !== finalSummary.counts.tests) {
    problems.push(`the file reported ${fileSummary.counts.tests} tests but the runner received ${finalSummary.counts.tests}`);
  }

  yield JSON.stringify({
    complete: problems.length === 0,
    problems,
    counts: finalSummary?.counts ?? null,
    fileCounts: fileSummary?.counts ?? null,
  }) + "\n";
}
