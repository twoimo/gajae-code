const encoder = new TextEncoder();

function sse(events: unknown[]): Uint8Array {
	return encoder.encode(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
}

function completed(responseId: string, usage: { input: number; output: number }) {
	return {
		type: "response.completed",
		response: {
			id: responseId,
			model: "git-daemon-fixture-model",
			status: "completed",
			output: [],
			usage: {
				input_tokens: usage.input,
				output_tokens: usage.output,
				total_tokens: usage.input + usage.output,
			},
		},
	};
}

const askArguments = JSON.stringify({
	questions: [
		{
			id: "merge_decision",
			question: "Approve this deterministic fixture run?",
			options: [{ label: "Approve" }, { label: "Deny" }],
		},
	],
});

function toolCallResponse(): Uint8Array {
	const item = {
		type: "function_call",
		id: "fc_fixture_gate",
		call_id: "call_fixture_gate",
		name: "ask",
		arguments: askArguments,
	};
	return sse([
		{ type: "response.created", response: { id: "resp_fixture_gate", model: "git-daemon-fixture-model", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{
			type: "response.function_call_arguments.delta",
			item_id: item.id,
			output_index: 0,
			delta: askArguments,
		},
		{
			type: "response.function_call_arguments.done",
			item_id: item.id,
			output_index: 0,
			arguments: askArguments,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		completed("resp_fixture_gate", { input: 5, output: 7 }),
	]);
}

function finalResponse(text: string): Uint8Array {
	const item = {
		id: "msg_fixture_final",
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text }],
	};
	return sse([
		{ type: "response.created", response: { id: "resp_fixture_final", model: "git-daemon-fixture-model", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
		{ type: "response.output_item.done", output_index: 0, item },
		completed("resp_fixture_final", { input: 8, output: 13 }),
	]);
}

function functionCallOutputs(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input.flatMap(item => {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "function_call_output") return [];
		const output = (item as { output?: unknown }).output;
		return [typeof output === "string" ? output : JSON.stringify(output)];
	});
}


const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
			return new Response("not found", { status: 404 });
		}
		const body = (await request.json()) as { input?: unknown };
		const toolOutputs = functionCallOutputs(body.input);
		if (toolOutputs.length === 0) {
			return new Response(toolCallResponse(), { headers: { "content-type": "text/event-stream" } });
		}
		if (toolOutputs.some(output => output.includes("Deny"))) {
			return new Response(
				finalResponse("The workflow gate was denied and the fixture run completed."),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		if (toolOutputs.some(output => output.includes("Approve"))) {
			return new Response(
				finalResponse("The workflow gate was approved and the fixture run completed."),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		return new Response("unexpected fixture tool output", { status: 400 });
	},
	idleTimeout: 30,
});

process.stdout.write(`${server.port}\n`);
