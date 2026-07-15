/**
 * Lightweight daemon protocol contract for consumers that need generation
 * metadata without loading the Telegram daemon runtime.
 */

/** Protocol version the daemon advertises in its ClientHello. */
export const NOTIFICATION_PROTOCOL_VERSION = 3;

/**
 * Operational generation the current daemon build speaks. Decoupled from
 * {@link NOTIFICATION_PROTOCOL_VERSION} (#2304): additive `tool_activity` /
 * `reasoning_summary` frames do not bump the wire protocol version, but a
 * freshly-upgraded host must still recognize an older, still-live daemon that
 * predates capability-gated frame enforcement and trigger a reload. Bump this
 * on every daemon-behavior change independent of the wire version.
 *
 * NOTE(#2299 rebase): PR #2299 sets NOTIFICATION_PROTOCOL_VERSION=4 and
 * DAEMON_GENERATION=4; when #2304 rebases onto it, raise this to 5.
 */
export const DAEMON_GENERATION = 4;
