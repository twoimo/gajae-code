//! Central supervisor-gated execution for computer-use input.
//!
//! # Single side-effect authority
//! Every side-effecting input action passes [`execute_input`] before the
//! [`InputController`] touches the OS. The gate is fail-closed: it requires the
//! supervisor stop-path live + fresh + not-suspended, Accessibility granted,
//! and (for coordinate actions) a matching display epoch. `release_all` runs on
//! every non-success exit and whenever suspension is observed mid-flight, so a
//! partial drag never leaves a button held. Screenshot is read-only (see
//! [`super::capture`]) and is intentionally NOT gated here.
//!
//! The gate logic is OS-agnostic and unit-tested with a fake permission gate,
//! fake display context, a real [`Supervisor`], and a recording [`EventSink`];
//! macOS supplies the concrete permission/display providers.

use super::{
	coords::{CoordError, NormalizedDisplay},
	input::{EventSink, InputController, InputError, MouseButton},
	supervisor::Supervisor,
};

/// Blast-radius caps: bound the magnitude of a single action so one hijacked or
/// malformed action cannot type unbounded text, scroll without limit, or block
/// indefinitely. Side-effecting actions reject rather than silently truncate.
const MAX_TYPE_CHARS: u64 = 5_000;
const MAX_SCROLL_DELTA: f64 = 10_000.0;
const MAX_WAIT_MS: u64 = 60_000;

/// A side-effecting computer-use action (the 8 input primitives). Screenshot is
/// handled by the read-only capture path, not this executor.
#[derive(Debug, Clone, PartialEq)]
pub enum InputAction {
	/// Move + click.
	Click { x: f64, y: f64, button: MouseButton },
	/// Move + double click.
	DoubleClick { x: f64, y: f64, button: MouseButton },
	/// Move the cursor.
	Move { x: f64, y: f64 },
	/// Press, drag, release.
	Drag { x: f64, y: f64, to_x: f64, to_y: f64, button: MouseButton },
	/// Move + scroll by logical deltas.
	Scroll { x: f64, y: f64, scroll_x: f64, scroll_y: f64 },
	/// Type a unicode string.
	Type { text: String },
	/// Press/release named keys in order.
	Keypress { keys: Vec<String> },
	/// Abort-aware wait.
	Wait { ms: u64 },
}

impl InputAction {
	/// Whether the action targets a screenshot-space coordinate (and so needs a
	/// fresh, matching display epoch).
	#[must_use]
	pub const fn is_coordinate(&self) -> bool {
		matches!(
			self,
			Self::Click { .. }
				| Self::DoubleClick { .. }
				| Self::Move { .. }
				| Self::Drag { .. }
				| Self::Scroll { .. }
		)
	}
}

/// Reason an action was rejected or failed. Each maps to a stable error code so
/// the TS tool can surface consistent, actionable messages.
#[derive(Debug, Clone, PartialEq)]
pub enum ExecError {
	/// Kill-switch latched; input stays off until a user-only reset.
	Suspended,
	/// The global stop path is not live/fresh; input is disabled fail-closed.
	SupervisorNotLive,
	/// Accessibility is not granted; no input may be injected.
	PermissionRequired,
	/// The display changed since the screenshot the coordinates came from.
	DisplayStale,
	/// A coordinate was out of bounds / non-finite / invalid scale.
	Coord(CoordError),
	/// The action was cancelled (AbortSignal/timeout/supervisor stop).
	Cancelled,
	/// A key name was not recognized.
	UnknownKey(String),
	/// A single action's magnitude exceeded a blast-radius cap (unbounded type /
	/// scroll / wait) and was rejected before any side effect.
	BlastRadiusExceeded { action: &'static str, observed: u64, limit: u64 },
}

impl ExecError {
	/// Stable error code string for the TS surface.
	#[must_use]
	pub const fn code(&self) -> &'static str {
		match self {
			Self::Suspended => "COMPUTER_SUSPENDED",
			Self::SupervisorNotLive => "COMPUTER_SUPERVISOR_NOT_LIVE",
			Self::PermissionRequired => "COMPUTER_PERMISSION_REQUIRED",
			Self::DisplayStale => "COMPUTER_DISPLAY_STALE",
			Self::Coord(_) => "COMPUTER_COORD_INVALID",
			Self::Cancelled => "COMPUTER_CANCELLED",
			Self::UnknownKey(_) => "COMPUTER_UNKNOWN_KEY",
			Self::BlastRadiusExceeded { .. } => "COMPUTER_BLAST_RADIUS",
		}
	}
}

impl From<InputError> for ExecError {
	fn from(value: InputError) -> Self {
		match value {
			InputError::Coord(err) => Self::Coord(err),
			InputError::UnknownKey(key) => Self::UnknownKey(key),
		}
	}
}

impl std::fmt::Display for ExecError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Coord(err) => write!(f, "{}: {err}", self.code()),
			Self::UnknownKey(key) => write!(f, "{}: {key}", self.code()),
			Self::BlastRadiusExceeded { action, observed, limit } => {
				write!(f, "{}: {action} {observed}>{limit}", self.code())
			},
			_ => write!(f, "{}", self.code()),
		}
	}
}

impl std::error::Error for ExecError {}

/// Provides the current Accessibility (input) grant state. macOS implements
/// this over `permissions::accessibility_granted`; tests inject a fake.
pub trait PermissionGate {
	/// Whether Accessibility is currently granted.
	fn accessibility_granted(&self) -> bool;
}

/// Provides the current display epoch so coordinate actions can reject stale
/// screenshots. macOS implements this over the capture/display descriptor.
pub trait DisplayContext {
	/// The current display epoch (hash of topology/scale/origin).
	fn current_epoch(&self) -> u64;
}

#[cfg(target_os = "macos")]
pub struct MacPermissionGate;

#[cfg(target_os = "macos")]
impl PermissionGate for MacPermissionGate {
	fn accessibility_granted(&self) -> bool {
		crate::computer::permissions::accessibility_granted()
	}
}

#[cfg(target_os = "macos")]
pub struct MacDisplayContext;

#[cfg(target_os = "macos")]
impl DisplayContext for MacDisplayContext {
	fn current_epoch(&self) -> u64 {
		crate::computer::capture::current_display_epoch()
	}
}

/// Fail-closed gate run before any side-effecting input.
fn gate<P: PermissionGate, D: DisplayContext>(
	action: &InputAction,
	supervisor: &Supervisor,
	perms: &P,
	display_ctx: &D,
	expected_epoch: Option<u64>,
) -> Result<(), ExecError> {
	let status = supervisor.status();
	if status.suspended {
		return Err(ExecError::Suspended);
	}
	if !status.hotkey_live || !status.heartbeat_fresh {
		return Err(ExecError::SupervisorNotLive);
	}
	if !perms.accessibility_granted() {
		return Err(ExecError::PermissionRequired);
	}
	if action.is_coordinate()
		&& let Some(expected) = expected_epoch
		&& display_ctx.current_epoch() != expected
	{
		return Err(ExecError::DisplayStale);
	}
	blast_radius_check(action)?;
	Ok(())
}

/// Per-action magnitude check bounding a single action's "blast radius" so one
/// hijacked or malformed action cannot type unbounded text, scroll without
/// limit, or block indefinitely. Side-effecting actions reject rather than
/// silently truncate. Complements the spatial bounds in [`super::coords`].
fn blast_radius_check(action: &InputAction) -> Result<(), ExecError> {
	match action {
		InputAction::Type { text } => {
			let actual = u64::try_from(text.chars().count()).unwrap_or(u64::MAX);
			if actual > MAX_TYPE_CHARS {
				return Err(ExecError::BlastRadiusExceeded {
					action: "type",
					observed: actual,
					limit: MAX_TYPE_CHARS,
				});
			}
		},
		InputAction::Scroll { scroll_x, scroll_y, .. } => {
			let mag = scroll_x.abs().max(scroll_y.abs());
			if mag > MAX_SCROLL_DELTA {
				return Err(ExecError::BlastRadiusExceeded {
					action: "scroll",
					observed: mag as u64,
					limit: MAX_SCROLL_DELTA as u64,
				});
			}
		},
		InputAction::Wait { ms } => {
			if *ms > MAX_WAIT_MS {
				return Err(ExecError::BlastRadiusExceeded {
					action: "wait",
					observed: *ms,
					limit: MAX_WAIT_MS,
				});
			}
		},
		_ => {},
	}
	Ok(())
}

/// Execute a side-effecting input action through the fail-closed gate.
///
/// `cancelled` is polled before and (for multi-step actions) reflected via the
/// controller; on any error or observed suspension, `release_all` runs so no
/// mouse button or modifier is left held.
///
/// # Errors
/// Returns [`ExecError`] when the gate rejects (suspended / not-live /
/// permission / stale display), the action is cancelled, or the controller
/// reports a coordinate/key error.
pub fn execute_input<S, P, D>(
	action: &InputAction,
	supervisor: &Supervisor,
	perms: &P,
	display_ctx: &D,
	expected_epoch: Option<u64>,
	display: &NormalizedDisplay,
	controller: &mut InputController<S>,
	cancelled: &dyn Fn() -> bool,
) -> Result<(), ExecError>
where
	S: EventSink,
	P: PermissionGate,
	D: DisplayContext,
{
	gate(action, supervisor, perms, display_ctx, expected_epoch)?;
	if cancelled() {
		return Err(ExecError::Cancelled);
	}

	let result = dispatch(action, display, controller, cancelled);

	// release_all on any failure, or if the kill-switch latched mid-action.
	if result.is_err() || supervisor.is_suspended() {
		controller.release_all();
	}
	result
}

fn dispatch<S: EventSink>(
	action: &InputAction,
	display: &NormalizedDisplay,
	controller: &mut InputController<S>,
	cancelled: &dyn Fn() -> bool,
) -> Result<(), ExecError> {
	match action {
		InputAction::Click { x, y, button } => controller
			.click(display, *x, *y, *button)
			.map_err(Into::into),
		InputAction::DoubleClick { x, y, button } => controller
			.double_click(display, *x, *y, *button)
			.map_err(Into::into),
		InputAction::Move { x, y } => controller.move_to(display, *x, *y).map_err(Into::into),
		InputAction::Drag { x, y, to_x, to_y, button } => controller
			.drag(display, *x, *y, *to_x, *to_y, *button)
			.map_err(Into::into),
		InputAction::Scroll { x, y, scroll_x, scroll_y } => controller
			.scroll(display, *x, *y, *scroll_x, *scroll_y)
			.map_err(Into::into),
		InputAction::Type { text } => {
			controller.type_text(text);
			Ok(())
		},
		InputAction::Keypress { keys } => controller.keypress(keys).map_err(Into::into),
		InputAction::Wait { ms } => wait_abortable(*ms, cancelled),
	}
}

/// Sleep up to `ms`, checking `cancelled` periodically.
fn wait_abortable(ms: u64, cancelled: &dyn Fn() -> bool) -> Result<(), ExecError> {
	use std::time::{Duration, Instant};
	let deadline = Instant::now() + Duration::from_millis(ms);
	while Instant::now() < deadline {
		if cancelled() {
			return Err(ExecError::Cancelled);
		}
		std::thread::sleep(Duration::from_millis(ms.min(10)));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::{DisplayContext, ExecError, InputAction, PermissionGate, execute_input};
	use crate::computer::{
		coords::{LogicalPoint, NormalizedDisplay},
		input::{EventSink, InputController, MouseButton, SinkOp},
		supervisor::{HEARTBEAT_FRESH_MS, Supervisor},
	};
	use std::{
		fs,
		path::PathBuf,
		time::{SystemTime, UNIX_EPOCH},
	};

	struct FakePerms {
		granted: bool,
	}
	impl PermissionGate for FakePerms {
		fn accessibility_granted(&self) -> bool {
			self.granted
		}
	}

	struct FakeDisplay {
		epoch: u64,
	}
	impl DisplayContext for FakeDisplay {
		fn current_epoch(&self) -> u64 {
			self.epoch
		}
	}

	#[derive(Default)]
	struct RecordingSink {
		ops: Vec<SinkOp>,
	}
	impl EventSink for RecordingSink {
		fn move_cursor(&mut self, to: LogicalPoint) {
			self.ops.push(SinkOp::Move(to));
		}

		fn mouse_button(&mut self, at: LogicalPoint, button: MouseButton, down: bool) {
			self.ops.push(SinkOp::Button { at, button, down });
		}

		fn scroll(&mut self, dx: f64, dy: f64) {
			self.ops.push(SinkOp::Scroll { dx, dy });
		}

		fn type_unicode(&mut self, text: &str) {
			self.ops.push(SinkOp::TypeUnicode(text.to_string()));
		}

		fn key(&mut self, code: u16, down: bool) {
			self.ops.push(SinkOp::Key { code, down });
		}
	}

	fn display() -> NormalizedDisplay {
		NormalizedDisplay::new(200, 100, 2.0, 2.0, 0.0, 0.0)
	}

	fn live_supervisor() -> Supervisor {
		let s = Supervisor::new();
		s.set_hotkey_live(true);
		s.heartbeat();
		s
	}

	fn never_cancel() -> impl Fn() -> bool {
		|| false
	}

	fn run(
		action: &InputAction,
		sup: &Supervisor,
		granted: bool,
		expected_epoch: Option<u64>,
		current_epoch: u64,
	) -> (Result<(), ExecError>, Vec<SinkOp>) {
		let mut controller = InputController::new(RecordingSink::default());
		let perms = FakePerms { granted };
		let disp_ctx = FakeDisplay { epoch: current_epoch };
		let cancel = never_cancel();
		let res = execute_input(
			action,
			sup,
			&perms,
			&disp_ctx,
			expected_epoch,
			&display(),
			&mut controller,
			&cancel,
		);
		(res, controller.into_sink().ops)
	}

	fn now_epoch_ms() -> u128 {
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock before unix epoch")
			.as_millis()
	}

	fn artifacts_dir() -> PathBuf {
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("../..")
			.join("artifacts/computer-redteam")
	}

	fn write_transcript(
		case_id: &str,
		selector: &str,
		started_ms: u128,
		asserted_ms: u128,
		assertions: Vec<serde_json::Value>,
	) -> PathBuf {
		let dir = artifacts_dir();
		fs::create_dir_all(&dir).expect("create computer redteam artifact directory");
		let path = dir.join(format!("{case_id}.json"));
		let artifact = serde_json::json!({
			"schemaVersion": 1,
			"surface": "native",
			"tool": "pi-natives-computer-redteam-harness",
			"actions": [{
				"type": "custom",
				"timestamp": started_ms,
				"selector": selector,
			}],
			"assertions": assertions.into_iter().map(|mut assertion| {
				if let Some(object) = assertion.as_object_mut() {
					object.insert("timestamp".to_string(), serde_json::json!(asserted_ms));
					object.insert("status".to_string(), serde_json::json!("passed"));
				}
				assertion
			}).collect::<Vec<_>>(),
		});
		fs::write(&path, serde_json::to_vec_pretty(&artifact).expect("serialize transcript"))
			.expect("write transcript");
		path
	}

	#[test]
	fn writes_mandatory_computer_redteam_transcripts() {
		let started = now_epoch_ms();
		let sup = live_supervisor();
		sup.trigger_stop();
		let (res, ops) = run(&InputAction::Move { x: 10.0, y: 10.0 }, &sup, true, None, 0);
		let asserted = now_epoch_ms();
		assert_eq!(res, Err(ExecError::Suspended));
		assert!(ops.is_empty(), "no events when suspended");
		write_transcript(
			"suspended-enforcement",
			"suspended_rejects_before_any_sink_op",
			started,
			asserted,
			vec![
				serde_json::json!({ "message": "observed ExecError::Suspended", "actual": format!("{:?}", res) }),
				serde_json::json!({ "message": "sink op count remained zero", "actual": ops.len() }),
			],
		);

		let started = now_epoch_ms();
		let sup = live_supervisor();
		let (res, ops) = run(&InputAction::Move { x: 1.0, y: 1.0 }, &sup, false, None, 0);
		let asserted = now_epoch_ms();
		assert_eq!(res, Err(ExecError::PermissionRequired));
		assert!(ops.is_empty());
		write_transcript(
			"permission-revoked",
			"missing_accessibility_rejects",
			started,
			asserted,
			vec![
				serde_json::json!({ "message": "observed ExecError::PermissionRequired", "actual": format!("{:?}", res) }),
				serde_json::json!({ "message": "sink op count remained zero", "actual": ops.len() }),
			],
		);

		let started = now_epoch_ms();
		let sup = live_supervisor();
		let (res, ops) = run(
			&InputAction::Click { x: 1.0, y: 1.0, button: MouseButton::Left },
			&sup,
			true,
			Some(7),
			9,
		);
		let asserted = now_epoch_ms();
		assert_eq!(res, Err(ExecError::DisplayStale));
		assert!(ops.is_empty());
		write_transcript(
			"display-stale",
			"stale_display_epoch_rejects_coordinate_action",
			started,
			asserted,
			vec![
				serde_json::json!({ "message": "observed ExecError::DisplayStale", "actual": format!("{:?}", res) }),
				serde_json::json!({ "message": "sink op count remained zero", "actual": ops.len() }),
			],
		);

		let started = now_epoch_ms();
		let sup = live_supervisor();
		let action =
			InputAction::Drag { x: 0.0, y: 0.0, to_x: 999.0, to_y: 0.0, button: MouseButton::Left };
		let (res, ops) = run(&action, &sup, true, None, 0);
		let asserted = now_epoch_ms();
		assert!(matches!(res, Err(ExecError::Coord(_))));
		let downs = ops
			.iter()
			.filter(|o| matches!(o, SinkOp::Button { down: true, .. }))
			.count();
		let ups = ops
			.iter()
			.filter(|o| matches!(o, SinkOp::Button { down: false, .. }))
			.count();
		assert_eq!(downs, ups, "every press is released after the error path");
		write_transcript(
			"out-of-bounds-drift",
			"out_of_bounds_coordinate_errors_and_releases",
			started,
			asserted,
			vec![
				serde_json::json!({ "message": "observed ExecError::Coord", "actual": format!("{:?}", res) }),
				serde_json::json!({ "message": "button down count equals button up count", "actual": { "downs": downs, "ups": ups } }),
			],
		);

		let started = now_epoch_ms();
		let sup = Supervisor::new();
		sup.set_hotkey_live(true);
		sup.heartbeat_at(10_000);
		let stale = 10_000 + HEARTBEAT_FRESH_MS + 1;
		let status = sup.status_at(stale);
		let asserted = now_epoch_ms();
		assert!(!status.input_allowed(), "stale heartbeat must fail closed");
		write_transcript(
			"runaway-loop-halt",
			"stale_heartbeat_disables_input",
			started,
			asserted,
			vec![serde_json::json!({
				"message": "stale heartbeat disabled input",
				"actual": {
					"suspended": status.suspended,
					"hotkey_live": status.hotkey_live,
					"heartbeat_fresh": status.heartbeat_fresh,
					"input_allowed": status.input_allowed(),
				},
			})],
		);

		let started = now_epoch_ms();
		let sup = live_supervisor();
		let oversized = InputAction::Type { text: "x".repeat(super::MAX_TYPE_CHARS as usize + 1) };
		let (res, ops) = run(&oversized, &sup, true, None, 0);
		let asserted = now_epoch_ms();
		assert!(matches!(res, Err(ExecError::BlastRadiusExceeded { .. })));
		assert!(ops.is_empty(), "oversized action rejected before any side effect");
		write_transcript(
			"blast-radius",
			"blast_radius_caps_oversized_actions",
			started,
			asserted,
			vec![
				serde_json::json!({ "message": "oversized Type exceeded the blast-radius cap and was rejected", "actual": format!("{:?}", res) }),
				serde_json::json!({ "message": "no sink ops emitted (rejected before side effect)", "actual": ops.len() }),
			],
		);
	}
	#[cfg(target_os = "macos")]
	#[test]
	#[ignore = "starts the global kill-switch event tap and posts a synthetic hotkey; needs macOS + grants"]
	fn writes_kill_switch_bypass_transcript() {
		use crate::computer::{hotkey, permissions::accessibility_granted};
		use std::{thread, time::Duration};

		assert!(
			accessibility_granted(),
			"Accessibility must be granted to exercise the real event tap"
		);
		let global = Supervisor::global();
		global.reset();
		assert!(hotkey::start(), "kill-switch listener should be live (session event tap created)");
		assert!(!global.is_suspended(), "supervisor must not be latched before the hotkey fires");

		let started = now_epoch_ms();
		// Post the hotkey through the REAL session event tap (not a direct latch)
		// — the same path a hardware key press takes. The tap callback latches.
		hotkey::post_synthetic_hotkey();
		let mut latched_via_event_tap = false;
		for _ in 0..100 {
			if global.is_suspended() {
				latched_via_event_tap = true;
				break;
			}
			thread::sleep(Duration::from_millis(20));
		}
		let posted = now_epoch_ms();
		assert!(
			latched_via_event_tap,
			"synthetic hotkey through the real event tap must latch the supervisor"
		);

		// Subsequent input must be blocked — the kill-switch cannot be bypassed.
		let (res, ops) = run(&InputAction::Move { x: 10.0, y: 10.0 }, global, true, None, 0);
		let asserted = now_epoch_ms();
		assert_eq!(res, Err(ExecError::Suspended));
		assert!(ops.is_empty(), "no events emitted while the kill-switch is latched");
		write_transcript(
			"kill-switch-bypass",
			"synthetic_hotkey_triggers_stop",
			started,
			asserted,
			vec![
				serde_json::json!({
					"message": "Control+Option+Command+Escape posted through the real CGEventTap latched the supervisor",
					"actual": { "latched_via_event_tap": latched_via_event_tap, "posted_ms": posted }
				}),
				serde_json::json!({
					"message": "input blocked after latch (kill-switch not bypassable)",
					"actual": { "result": format!("{:?}", res), "sink_ops": ops.len() }
				}),
			],
		);
		global.reset();
	}

	#[test]
	fn blast_radius_caps_oversized_actions() {
		let sup = live_supervisor();

		// Oversized Type -> rejected before any side effect.
		let (res, ops) = run(
			&InputAction::Type { text: "x".repeat(super::MAX_TYPE_CHARS as usize + 1) },
			&sup,
			true,
			None,
			0,
		);
		assert!(matches!(res, Err(ExecError::BlastRadiusExceeded { action: "type", .. })));
		assert!(ops.is_empty());

		// Oversized Scroll -> rejected.
		let (res, ops) = run(
			&InputAction::Scroll {
				x: 1.0,
				y: 1.0,
				scroll_x: 0.0,
				scroll_y: super::MAX_SCROLL_DELTA + 1.0,
			},
			&sup,
			true,
			None,
			0,
		);
		assert!(matches!(res, Err(ExecError::BlastRadiusExceeded { action: "scroll", .. })));
		assert!(ops.is_empty());

		// Oversized Wait -> rejected.
		let (res, ops) = run(&InputAction::Wait { ms: super::MAX_WAIT_MS + 1 }, &sup, true, None, 0);
		assert!(matches!(res, Err(ExecError::BlastRadiusExceeded { action: "wait", .. })));
		assert!(ops.is_empty());

		// In-bounds actions still pass through unchanged.
		let (res, ops) = run(&InputAction::Type { text: "ok".to_string() }, &sup, true, None, 0);
		assert!(res.is_ok());
		assert_eq!(ops.len(), 1, "in-bounds type emits exactly one sink op");
	}

	#[test]
	fn suspended_rejects_before_any_sink_op() {
		let sup = live_supervisor();
		sup.trigger_stop();
		let (res, ops) = run(&InputAction::Move { x: 10.0, y: 10.0 }, &sup, true, None, 0);
		assert_eq!(res, Err(ExecError::Suspended));
		assert!(ops.is_empty(), "no events when suspended");
	}

	#[test]
	fn not_live_rejects() {
		let sup = Supervisor::new(); // hotkey not live
		let (res, ops) = run(
			&InputAction::Click { x: 1.0, y: 1.0, button: MouseButton::Left },
			&sup,
			true,
			None,
			0,
		);
		assert_eq!(res, Err(ExecError::SupervisorNotLive));
		assert!(ops.is_empty());
	}

	#[test]
	fn missing_accessibility_rejects() {
		let sup = live_supervisor();
		let (res, ops) = run(&InputAction::Move { x: 1.0, y: 1.0 }, &sup, false, None, 0);
		assert_eq!(res, Err(ExecError::PermissionRequired));
		assert!(ops.is_empty());
	}

	#[test]
	fn stale_display_epoch_rejects_coordinate_action() {
		let sup = live_supervisor();
		let (res, ops) = run(
			&InputAction::Click { x: 1.0, y: 1.0, button: MouseButton::Left },
			&sup,
			true,
			Some(7),
			9,
		);
		assert_eq!(res, Err(ExecError::DisplayStale));
		assert!(ops.is_empty());
	}

	#[test]
	fn matching_epoch_allows_action() {
		let sup = live_supervisor();
		let (res, ops) = run(
			&InputAction::Click { x: 100.0, y: 50.0, button: MouseButton::Left },
			&sup,
			true,
			Some(7),
			7,
		);
		assert!(res.is_ok());
		assert!(!ops.is_empty());
	}

	#[test]
	fn out_of_bounds_coordinate_errors_and_releases() {
		let sup = live_supervisor();
		// drag to out-of-bounds: press happens then error -> release_all leaves nothing
		// held.
		let action =
			InputAction::Drag { x: 0.0, y: 0.0, to_x: 999.0, to_y: 0.0, button: MouseButton::Left };
		let (res, ops) = run(&action, &sup, true, None, 0);
		assert!(matches!(res, Err(ExecError::Coord(_))));
		let downs = ops
			.iter()
			.filter(|o| matches!(o, SinkOp::Button { down: true, .. }))
			.count();
		let ups = ops
			.iter()
			.filter(|o| matches!(o, SinkOp::Button { down: false, .. }))
			.count();
		assert_eq!(downs, ups, "every press is released after the error path");
	}

	#[test]
	fn type_and_keypress_pass_the_gate() {
		let sup = live_supervisor();
		let (res, ops) = run(&InputAction::Type { text: "hi".to_string() }, &sup, true, None, 0);
		assert!(res.is_ok());
		assert_eq!(ops, vec![SinkOp::TypeUnicode("hi".to_string())]);

		let (res2, ops2) =
			run(&InputAction::Keypress { keys: vec!["enter".to_string()] }, &sup, true, None, 0);
		assert!(res2.is_ok());
		assert_eq!(ops2.len(), 2); // key down + up
	}

	#[test]
	fn wait_zero_is_ok() {
		let sup = live_supervisor();
		let (res, _) = run(&InputAction::Wait { ms: 0 }, &sup, true, None, 0);
		assert!(res.is_ok());
	}

	#[test]
	fn error_codes_are_stable() {
		assert_eq!(ExecError::Suspended.code(), "COMPUTER_SUSPENDED");
		assert_eq!(ExecError::SupervisorNotLive.code(), "COMPUTER_SUPERVISOR_NOT_LIVE");
		assert_eq!(ExecError::PermissionRequired.code(), "COMPUTER_PERMISSION_REQUIRED");
		assert_eq!(ExecError::DisplayStale.code(), "COMPUTER_DISPLAY_STALE");
	}
}
