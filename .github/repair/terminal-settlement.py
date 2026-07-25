from pathlib import Path

source_path = Path("packages/coding-agent/src/sdk/bus/telegram-daemon.ts")
source = source_path.read_text()

old_helper = '''\tprivate failLegacyToolStart(toolActivity: ToolActivityOwner | undefined): void {
\t\tif (toolActivity?.phase !== "started") return;
\t\tconst state = this.legacyToolStarts.get(`${toolActivity.sessionId}:tool:${toolActivity.toolCallId}`);
\t\tif (state !== undefined && state.owner === toolActivity && state.phase !== "visible")
\t\t\tthis.settleLegacyToolStart(state, "failed");
\t}
'''
new_helper = old_helper + '''
\tprivate settleRejectedLegacyToolSubmission(
\t\ttoolActivity: ToolActivityOwner | undefined,
\t\tlegacyToolStart: LegacyToolStartSettlement | undefined,
\t): void {
\t\tif (toolActivity?.phase === "started") {
\t\t\tthis.failLegacyToolStart(toolActivity);
\t\t\treturn;
\t\t}
\t\tif (
\t\t\ttoolActivity?.phase !== "terminal" ||
\t\t\tlegacyToolStart === undefined ||
\t\t\tthis.legacyToolStarts.get(legacyToolStart.key) !== legacyToolStart
\t\t)
\t\t\treturn;
\t\tthis.settleLegacyToolStart(legacyToolStart, "terminal");
\t\tthis.liveMessages.delete(legacyToolStart.key);
\t\tif (this.toolActivityOwners.get(legacyToolStart.key) === legacyToolStart.owner)
\t\t\tthis.toolActivityOwners.delete(legacyToolStart.key);
\t}
'''
if "private settleRejectedLegacyToolSubmission(" not in source:
    if source.count(old_helper) != 1:
        raise SystemExit("failLegacyToolStart anchor mismatch")
    source = source.replace(old_helper, new_helper, 1)

old_threaded = '''\t\tif (!submitted) {
\t\t\tthis.failLegacyToolStart(toolActivity);
\t\t\treturn;
\t\t}
'''
new_threaded = '''\t\tif (!submitted) {
\t\t\tthis.settleRejectedLegacyToolSubmission(toolActivity, legacyStart);
\t\t\treturn;
\t\t}
'''
if old_threaded in source:
    source = source.replace(old_threaded, new_threaded, 1)
elif new_threaded not in source:
    raise SystemExit("threaded submission anchor mismatch")

old_flat = '''\t\tconst legacyToolStart = toolActivity ? this.legacyToolStartForTerminal(toolActivity) : undefined;
\t\tthis.submitPool({
\t\t\tsessionId,
\t\t\tlane: send.lane,
\t\t\tcoalesceKey: send.coalesceKey,
\t\t\tpayload: {
\t\t\t\tsend,
\t\t\t\t...(socketLease ? { socketLease } : {}),
\t\t\t\t...(toolActivity ? { toolActivity } : {}),
\t\t\t\t...(legacyToolStart ? { legacyToolStart } : {}),
\t\t\t},
\t\t});
\t\tawait this.flushPool();
'''
new_flat = '''\t\tconst legacyToolStart = toolActivity ? this.legacyToolStartForTerminal(toolActivity) : undefined;
\t\tconst submitted = this.submitPool({
\t\t\tsessionId,
\t\t\tlane: send.lane,
\t\t\tcoalesceKey: send.coalesceKey,
\t\t\tpayload: {
\t\t\t\tsend,
\t\t\t\t...(socketLease ? { socketLease } : {}),
\t\t\t\t...(toolActivity ? { toolActivity } : {}),
\t\t\t\t...(legacyToolStart ? { legacyToolStart } : {}),
\t\t\t},
\t\t});
\t\tif (!submitted) {
\t\t\tthis.settleRejectedLegacyToolSubmission(toolActivity, legacyToolStart);
\t\t\treturn;
\t\t}
\t\tawait this.flushPool();
'''
if old_flat in source:
    source = source.replace(old_flat, new_flat, 1)
elif new_flat not in source:
    raise SystemExit("flat submission anchor mismatch")
source_path.write_text(source)

test_path = Path("packages/coding-agent/test/notifications-telegram-daemon.test.ts")
tests = test_path.read_text()
marker = '\ttest("legacy-v1 unknown closes only an already-visible start as summary-free cancelled", async () => {'
if tests.count(marker) != 1:
    raise SystemExit("test insertion anchor mismatch")
regression = '''\ttest.each(["threaded", "flat"] as const)(
\t\t"legacy-v1 %s terminal submission rejection retires exact settlement before reuse",
\t\tasync route => {
\t\t\tconst bot = new FakeBotApi();
\t\t\tif (route === "flat") {
\t\t\t\tconst originalCall = bot.call.bind(bot);
\t\t\t\tbot.call = async (method, body, options) => {
\t\t\t\t\tif (method === "createForumTopic") {
\t\t\t\t\t\tbot.calls.push({ method, body, options });
\t\t\t\t\t\treturn { ok: false, error_code: 400, description: "forum topics are disabled" };
\t\t\t\t\t}
\t\t\t\t\treturn await originalCall(method, body, options);
\t\t\t\t};
\t\t\t}
\t\t\tconst daemon = new TelegramNotificationDaemon({
\t\t\t\tsettings: settings(tempAgentDir()),
\t\t\t\townerId: "owner",
\t\t\t\tbotToken: "tok",
\t\t\t\tchatId: "42",
\t\t\t\tbotApi: bot,
\t\t\t\ttoolActivity: { enabled: true },
\t\t\t});
\t\t\tconst session = richSession();
\t\t\tawait daemon.handleSessionMessage(session, {
\t\t\t\ttype: "hello",
\t\t\t\tcapabilities: [LEGACY_TOOL_ACTIVITY_CAPABILITY],
\t\t\t});
\t\t\tawait daemon.handleSessionMessage(session, {
\t\t\t\ttype: "identity_header",
\t\t\t\tsessionId: "S",
\t\t\t\trepo: "repo",
\t\t\t\tbranch: "branch",
\t\t\t});
\t\t\tbot.calls = [];
\t\t\tconst toolCallId = `terminal-rejected-${route}`;
\t\t\tconst key = `S:tool:${toolCallId}`;
\t\t\tconst startFrame = {
\t\t\t\ttype: "tool_activity",
\t\t\t\tsessionId: "S",
\t\t\t\ttoolCallId,
\t\t\t\ttoolName: "read",
\t\t\t\tphase: "started",
\t\t\t};
\t\t\tawait daemon.handleSessionMessage(session, startFrame);
\t\t\tconst runtime = daemon as unknown as {
\t\t\t\tlegacyToolStarts: Map<string, unknown>;
\t\t\t\tliveMessages: Map<string, number>;
\t\t\t\ttoolActivityOwners: Map<string, unknown>;
\t\t\t\tsubmitPool: (item: unknown) => boolean;
\t\t\t};
\t\t\texpect(runtime.legacyToolStarts.has(key)).toBe(true);
\t\t\texpect(runtime.liveMessages.has(key)).toBe(true);
\t\t\tconst originalSubmitPool = runtime.submitPool.bind(daemon);
\t\t\truntime.submitPool = () => false;
\t\t\ttry {
\t\t\t\tawait daemon.handleSessionMessage(session, { ...startFrame, phase: "completed" });
\t\t\t} finally {
\t\t\t\truntime.submitPool = originalSubmitPool;
\t\t\t}
\t\t\texpect(runtime.legacyToolStarts.has(key)).toBe(false);
\t\t\texpect(runtime.liveMessages.has(key)).toBe(false);
\t\t\texpect(runtime.toolActivityOwners.has(key)).toBe(false);
\t\t\tconst sendsBeforeReuse = bot.calls.filter(call => call.method === "sendMessage").length;
\t\t\tconst editsBeforeReuse = bot.calls.filter(call => call.method === "editMessageText").length;
\t\t\tawait daemon.handleSessionMessage(session, startFrame);
\t\t\texpect(runtime.legacyToolStarts.has(key)).toBe(true);
\t\t\texpect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(sendsBeforeReuse + 1);
\t\t\texpect(bot.calls.filter(call => call.method === "editMessageText")).toHaveLength(editsBeforeReuse);
\t\t},
\t);
'''
if "terminal submission rejection retires exact settlement before reuse" not in tests:
    tests = tests.replace(marker, regression + marker)
    test_path.write_text(tests)
