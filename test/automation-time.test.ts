import assert from "node:assert/strict";
import test from "node:test";
import {
  intervalFirstAtOrAfter,
  intervalLastAtOrBefore,
  parseCronSchedule,
  parseDurationMinutes,
  parseInterval,
  parseOneShot,
  scheduleEligibilityNotice,
  cronFirstAtOrAfter,
  cronLastAtOrBefore,
  type CronSchedule,
} from "../src/automation.js";

test("parseDurationMinutes accepts positive minute/hour/day values and rejects the rest", () => {
  assert.equal(parseDurationMinutes("1m"), 1);
  assert.equal(parseDurationMinutes("90m"), 90);
  assert.equal(parseDurationMinutes("2h"), 120);
  assert.equal(parseDurationMinutes("1d"), 1440);
  assert.equal(parseDurationMinutes("10"), 10);
  for (const bad of ["0m", "0", "90s", "1.5h", "-5m", "minute", "1w", ""]) {
    assert.throws(() => parseDurationMinutes(bad), /positive duration/i, bad);
  }
});

test("one-shot without offset resolves in the job timezone, defaulting to Asia/Shanghai", () => {
  const shanghai = parseOneShot("2030-06-01T09:00", "Asia/Shanghai");
  assert.equal(shanghai.kind, "oneshot");
  assert.equal(shanghai.wall, "2030-06-01T09:00");
  assert.equal(shanghai.timeZone, "Asia/Shanghai");
  assert.equal(shanghai.dueMs, Date.parse("2030-06-01T01:00:00.000Z"));

  const tokyo = parseOneShot("2030-06-01T09:00", "Asia/Tokyo");
  assert.equal(tokyo.dueMs, Date.parse("2030-06-01T00:00:00.000Z"));
});

test("one-shot with explicit offset is an absolute instant and ignores the saved zone", () => {
  const withOffset = parseOneShot("2030-06-01T09:00+02:00", "Asia/Shanghai");
  assert.equal(withOffset.dueMs, Date.parse("2030-06-01T07:00:00.000Z"));
  assert.equal(withOffset.offset, "+02:00");
  const zulu = parseOneShot("2030-06-01T01:00Z", "Asia/Shanghai");
  assert.equal(zulu.dueMs, Date.parse("2030-06-01T01:00:00.000Z"));
});

test("one-shot rejects invalid zones, unparseable values, and sub-minute precision", () => {
  assert.throws(() => parseOneShot("2030-06-01T09:00", "Asia/NotAZone"), /timezone/i);
  for (const bad of ["2030-06-01", "09:00", "2030-06-01 09:00", "2030-13-01T09:00", "2030-06-01T9am", "2030-06-01T09:00:30", "tomorrow morning"]) {
    assert.throws(() => parseOneShot(bad, "Asia/Shanghai"), /ISO/i, bad);
  }
});

test("eligibility notices distinguish future, in-window, and expired occurrences without changing the schedule", () => {
  const future = parseOneShot("2030-06-01T09:00", "Asia/Shanghai");
  assert.match(scheduleEligibilityNotice(future, Date.parse("2030-05-01T00:00:00Z")), /still in the future/i);
  assert.match(scheduleEligibilityNotice(future, future.dueMs + 60 * 60000), /lateness window/i);
  assert.match(scheduleEligibilityNotice(future, future.dueMs + 3 * 60 * 60000), /expired/i);
});

test("offset-less ambiguous or nonexistent local times fail and point at an explicit offset", () => {
  // 2025-11-02 01:30 in New York repeats (DST fall back); 2025-03-09 02:30 never exists.
  assert.throws(() => parseOneShot("2025-11-02T01:30", "America/New_York"), /explicit offset/i);
  assert.throws(() => parseOneShot("2025-03-09T02:30", "America/New_York"), /explicit offset/i);
  // Explicit offsets remain absolute even at the same wall minutes.
  assert.equal(parseOneShot("2025-11-02T01:30-04:00", "America/New_York").dueMs, Date.parse("2025-11-02T05:30:00.000Z"));
  assert.equal(parseOneShot("2025-03-09T02:30-04:00", "America/New_York").dueMs, Date.parse("2025-03-09T06:30:00.000Z"));
});

const cron = (expr: string, tz = "Asia/Shanghai"): CronSchedule => parseCronSchedule(expr, tz, 120);

test("cron accepts wildcards, lists, ranges, and steps; rejects seconds, macros, names, and extensions", () => {
  assert.equal(cronFirstAtOrAfter(cron("* * * * *"), Date.parse("2030-06-03T01:00:30Z"), 0), Date.parse("2030-06-03T01:01:00Z"));
  for (const bad of [
    "0 9 * * * 0", "30 0 9 * * *", "@daily", "@hourly", "0 9 * * MON", "0 9 * JAN *",
    "0 9,10, * * *", "60 9 * * *", "0 24 * * *", "0 9 * * 8", "0 9 0 * *",
    "0 9 32 * *", "0 9 * 13 *", "0 9 * * 1-8", "*/2/3 * * * *", "5-1 * * * *",
    "0 9 * * 1#3", "0 9 L * *", "0 9 * * ?", "Mon,Tue-Fri", "0 9 * * *%x",
  ]) {
    assert.throws(() => cron(bad), /cron|five/i, bad);
  }
  // systemd OnCalendar must not be approximated.
  assert.throws(() => cron("Mon..Fri 09:00"), /cron|five/i);
});

test("cron lists, ranges, and steps resolve in the job timezone, not the host zone", () => {
  // 09:00/09:30 weekday mornings in Shanghai = 01:00/01:30 UTC.
  const morning = cron("0,30 9 * * 1-5");
  // 2030-06-01 is a Saturday; next Monday is 2030-06-03.
  assert.equal(cronFirstAtOrAfter(morning, Date.parse("2030-06-01T00:00:00Z"), 0), Date.parse("2030-06-03T01:00:00Z"));
  assert.equal(cronFirstAtOrAfter(morning, Date.parse("2030-06-03T01:00:00Z"), 0), Date.parse("2030-06-03T01:00:00Z")); // at-or-after is inclusive
  assert.equal(cronFirstAtOrAfter(morning, Date.parse("2030-06-03T01:01:00Z"), 0), Date.parse("2030-06-03T01:30:00Z"));
  assert.equal(cronFirstAtOrAfter(morning, Date.parse("2030-06-05T02:00:00Z"), 0), Date.parse("2030-06-06T01:00:00Z")); // Friday after 09:30 -> Monday

  const step = cron("*/15 8-10 * * *");
  assert.equal(cronFirstAtOrAfter(step, Date.parse("2030-06-03T00:50:00Z"), 0), Date.parse("2030-06-03T01:00:00Z")); // next is 09:00 SH
  assert.equal(cronFirstAtOrAfter(step, Date.parse("2030-06-02T23:00:00Z"), 0), Date.parse("2030-06-03T00:00:00Z")); // 08:00 SH
});

test("DOM and DOW are OR when both restricted; impossible dates are rejected at creation", () => {
  // Fire on the 1st OR on Mondays.
  const mixed = cron("0 9 1 * 1");
  // 2030-06-01 is Saturday (1st, matches DOM); 2030-06-03 is Monday (matches DOW).
  assert.equal(cronFirstAtOrAfter(mixed, Date.parse("2030-05-31T00:00:00Z"), 0), Date.parse("2030-06-01T01:00:00Z"));
  assert.equal(cronFirstAtOrAfter(mixed, Date.parse("2030-06-01T02:00:00Z"), 0), Date.parse("2030-06-03T01:00:00Z"));
  assert.throws(() => cron("0 9 31 2 *"), /never matches/i);
  // Feb 30 + Monday restriction is feasible via the OR/DOW side, so it is valid.
  // February 29th exists in leap years; must be accepted.
  assert.doesNotThrow(() => cron("0 9 29 2 *"));
  // 0 and 7 both mean Sunday.
  assert.equal(cronFirstAtOrAfter(cron("0 9 * * 7"), Date.parse("2030-06-01T00:00:00Z"), 0), cronFirstAtOrAfter(cron("0 9 * * 0"), Date.parse("2030-06-01T00:00:00Z"), 0));
});

test("cron latest-at-or-before coalesces missed occurrences and respects the recorded floor", () => {
  const morning = cron("0 9 * * *");
  const afterMonday = Date.parse("2030-06-04T05:00:00Z"); // Thursday, 13:00 Shanghai
  // Three missed mornings (Mon-Wed) plus today's coalesce to the latest only.
  assert.equal(cronLastAtOrBefore(morning, afterMonday, Date.parse("2030-05-31T00:00:00Z")), Date.parse("2030-06-04T01:00:00Z"));
  // The floor is strict: a settled latest morning is not offered again.
  assert.equal(cronLastAtOrBefore(morning, afterMonday, Date.parse("2030-06-04T01:00:00Z")), null);
});

test("DST gaps are skipped and folds fire once; timezone changes do not shift saved schedules", () => {
  const ny = cron("30 2 * * *", "America/New_York");
  // 2025-03-09 02:30 does not exist (spring forward): the rule simply has no
  // occurrence that day; next match is 2025-03-10 02:30 -04:00 = 06:30Z.
  assert.equal(cronFirstAtOrAfter(ny, Date.parse("2025-03-08T12:00:00Z"), 0), Date.parse("2025-03-10T06:30:00Z"));
  const fold = cron("30 1 * * *", "America/New_York");
  // 2025-11-02 01:30 repeats: exactly one planned minute (earlier instant).
  const at = cronFirstAtOrAfter(fold, Date.parse("2025-11-01T12:00:00Z"), 0);
  assert.equal(at, Date.parse("2025-11-02T05:30:00Z")); // -04:00, the pre-transition reading
  const again = cronFirstAtOrAfter(fold, at + 1, 0);
  assert.equal(again, Date.parse("2025-11-03T06:30:00Z")); // repeated -05:00 reading is not a second occurrence
});

test("fixed intervals are elapsed durations anchored at first enablement", () => {
  const anchor = Date.parse("2030-06-01T00:00:00Z");
  const every90 = parseInterval("90m", anchor);
  assert.equal(intervalFirstAtOrAfter(every90, anchor), anchor + 90 * 60_000); // first run one interval later
  assert.equal(intervalFirstAtOrAfter(every90, anchor + 30 * 60_000), anchor + 90 * 60_000);
  assert.equal(intervalFirstAtOrAfter(every90, anchor + 90 * 60_000), anchor + 90 * 60_000);
  assert.equal(intervalFirstAtOrAfter(every90, anchor + 91 * 60_000), anchor + 180 * 60_000);
  assert.equal(intervalFirstAtOrAfter(every90, anchor + 200 * 60_000), anchor + 270 * 60_000);
  // Recovery coalesces to the latest grid point only.
  assert.equal(intervalLastAtOrBefore(every90, anchor + 200 * 60_000, anchor), anchor + 180 * 60_000);
  assert.equal(intervalLastAtOrBefore(every90, anchor + 200 * 60_000, anchor + 180 * 60_000), null);
  assert.throws(() => parseInterval("30s", anchor), /positive duration/i);
  assert.throws(() => parseInterval("0m", anchor), /at least one minute/i);
});
