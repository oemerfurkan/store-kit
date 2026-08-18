'use strict';

/**
 * How patient a read is allowed to be, shared by both store clients.
 *
 * Both Apple and Google return a bare 500 now and then that clears seconds later. That is
 * survivable per request and fatal per run: reading every price point for one subscription
 * walks dozens of pages, so a pricing run makes hundreds of reads, and at those numbers
 * meeting one 500 is the expected case rather than bad luck. The original budget of three
 * attempts over seven seconds was measured losing an entire run twice in a row while the
 * same command succeeded either side of it.
 *
 * The jitter is the part that is easy to leave out and worth keeping. Pages are walked in a
 * tight loop against one host, so a purely exponential backoff sends every retry in a run
 * into the same busy moment; spreading them costs nothing and stops a slow patch from
 * knocking over the whole walk.
 */

const RETRIES = 5;

/** Seconds to wait before attempt n, counting from zero. Roughly 1, 2, 4, 8, 16, jittered. */
function backoff(attempt) {
  const base = 2 ** attempt;
  return base * (0.75 + Math.random() * 0.5);
}

module.exports = { RETRIES, backoff };
