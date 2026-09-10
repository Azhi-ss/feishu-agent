import assert from "node:assert/strict";
import test from "node:test";
import { parseDurationMinutes, parseOneShot, scheduleEligibilityNotice } from "../src/automation.js";

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
