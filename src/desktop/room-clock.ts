/**
 * Room-clock estimate from round-trip `clock` pings (see `DesktopRoom.noteClockSample`).
 *
 * The room stamps `serverNow` somewhere inside the ping's round trip, so a sample's error is at
 * most half its round trip. A page busy with slow frames answers late: its samples can have
 * round trips of seconds, i.e. seconds of possible error. Such a sample must never replace a
 * good estimate — not even to "refresh" a minute-old one, because clock drift over minutes is
 * milliseconds, while a busy page's sample can be off by seconds.
 */
export interface ClockEstimate {
  /** Round trip of the sample the estimate comes from (ms). */
  rtt: number;
  /** When that sample arrived (this tab's clock, ms). */
  at: number;
}

/** A sample at or below this round trip is good enough to stop the fast resampling. */
export const CLOCK_GOOD_RTT = 500;
/** An estimate older than this may be refreshed by a sample of comparable quality (drift). */
export const CLOCK_REFRESH_MS = 60_000;

/** Whether a new round-trip sample should replace the current estimate. */
export function acceptClockSample(current: ClockEstimate | null, rtt: number, at: number): boolean {
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > 60_000) return false;
  if (!current) return true;
  if (rtt <= current.rtt) return true;
  return at - current.at > CLOCK_REFRESH_MS && rtt <= Math.max(CLOCK_GOOD_RTT, current.rtt * 2);
}
