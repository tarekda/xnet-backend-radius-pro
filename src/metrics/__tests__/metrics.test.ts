import { recordJobRun, register } from "../metrics";

/**
 * The monthly invoice cron relies on this to make its outcome visible; if the
 * metric family were misdeclared the failure would only show up as a runtime
 * error in the job, so assert the exposed series directly.
 */
describe("recordJobRun", () => {
  it("exposes a counter increment and a last-run timestamp", async () => {
    const before = Date.now() / 1000;

    recordJobRun("unit_test_job", "ok");

    const text = await register.metrics();

    expect(text).toMatch(/job_runs_total\{job="unit_test_job",result="ok"\}\s+1/);

    const gauge = text.match(/job_last_run_timestamp_seconds\{job="unit_test_job"\}\s+([\d.]+)/);
    expect(gauge).not.toBeNull();

    const stamp = Number(gauge![1]);
    expect(stamp).toBeGreaterThanOrEqual(Math.floor(before));
    expect(stamp).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  it("counts failures separately from successes", async () => {
    recordJobRun("unit_test_job", "error");

    const text = await register.metrics();

    expect(text).toMatch(/job_runs_total\{job="unit_test_job",result="error"\}\s+1/);
    expect(text).toMatch(/job_runs_total\{job="unit_test_job",result="ok"\}\s+1/);
  });
});
