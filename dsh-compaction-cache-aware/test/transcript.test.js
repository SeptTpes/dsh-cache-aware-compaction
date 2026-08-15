import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateReplayTokens, estimateTextTokens, renderMessage, renderTranscript } from "../lib/transcript.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], source: { kind: "model", provider: "p", model: "m" } });
const toolCall = (name, args) => ({ role: "assistant", content: [{ type: "tool-call", id: "call-1", name, arguments: args }], source: { kind: "model", provider: "p", model: "m" } });
const toolResult = (blocks, callId = "call-1") => ({ role: "user", content: [{ type: "tool-result", toolCallId: callId, content: blocks, isError: false }], source: { kind: "tool", callId } });

test("renders a plain user message", () => {
	assert.equal(renderMessage(user("hello world")), "[user] hello world");
});

test("renders an assistant text message", () => {
	assert.equal(renderMessage(assistant("let me check")), "[assistant] let me check");
});

test("renders assistant tool call with JSON arguments", () => {
	const m = toolCall("read_file", JSON.stringify({ path: "/tmp/a.txt" }));
	assert.equal(renderMessage(m), "[assistant → tool call: read_file({\"path\":\"/tmp/a.txt\"})]");
});

test("renders assistant text and tool call as separate lines", () => {
	const m = {
		role: "assistant",
		content: [
			{ type: "text", text: "reading file" },
			{ type: "tool-call", id: "c1", name: "grep", arguments: "{}" }
		],
		source: { kind: "model", provider: "p", model: "m" }
	};
	assert.equal(renderMessage(m), "[assistant] reading file\n[assistant → tool call: grep({})]");
});

test("renders a tool result with nested text", () => {
	const m = toolResult([{ type: "text", text: "found 3 matches" }]);
	assert.equal(renderMessage(m), "[tool result] found 3 matches");
});

test("tool result with nested image renders the image marker", () => {
	const m = toolResult([
		{ type: "text", text: "screenshot:" },
		{ type: "image", image: {} }
	]);
	assert.equal(renderMessage(m), "[tool result] screenshot:\n[image omitted]");
});

test("nested image inside nested tool-result content is detected", () => {
	const m = toolResult([
		{ type: "tool-result", toolCallId: "inner", content: [{ type: "image", image: {} }] }
	]);
	assert.equal(renderMessage(m), "[tool result] [tool result] [image omitted]");
});

test("bare image block renders as [image omitted]", () => {
	const m = { role: "user", content: [{ type: "image", image: {} }], source: { kind: "user" } };
	assert.equal(renderMessage(m), "[image omitted]");
});

test("unknown block type degrades to a marker, never throws", () => {
	const m = { role: "assistant", content: [{ type: "weird-block", data: 1 }], source: { kind: "model", provider: "p", model: "m" } };
	assert.equal(renderMessage(m), "[block: weird-block]");
});

test("reasoning block degrades to a marker (unlisted type)", () => {
	const m = { role: "assistant", content: [{ type: "reasoning", text: "thinking…" }], source: { kind: "model", provider: "p", model: "m" } };
	assert.equal(renderMessage(m), "[block: reasoning]");
});

test("empty and whitespace-only text blocks are skipped", () => {
	const m = { role: "user", content: [{ type: "text", text: "   " }], source: { kind: "user" } };
	assert.equal(renderMessage(m), "");
	const m2 = { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "real" }], source: { kind: "user" } };
	assert.equal(renderMessage(m2), "[user] real");
});

test("message without content renders empty", () => {
	assert.equal(renderMessage({ role: "user", source: { kind: "user" } }), "");
	assert.equal(renderMessage(null), "");
});

test("renderTranscript joins messages in order with newlines", () => {
	const messages = [user("do the thing"), assistant("on it"), toolCall("bash", "{}"), toolResult([{ type: "text", text: "done" }])];
	const expected = [
		"[user] do the thing",
		"[assistant] on it",
		"[assistant → tool call: bash({})]",
		"[tool result] done"
	].join("\n");
	assert.equal(renderTranscript(messages), expected);
});

test("renderTranscript skips empty messages", () => {
	const messages = [user(""), assistant("only me")];
	assert.equal(renderTranscript(messages), "[assistant] only me");
	assert.equal(renderTranscript([]), "");
	assert.equal(renderTranscript(null), "");
});

test("renderTranscript preserves inner whitespace of text (trim only edges)", () => {
	const m = user("  a   b  ");
	assert.equal(renderMessage(m), "[user] a   b");
});

test("estimateTextTokens is a conservative chars/3 estimate", () => {
	assert.equal(estimateTextTokens(""), 0);
	assert.equal(estimateTextTokens("abc"), 1);
	assert.equal(estimateTextTokens("abcd"), 2);
});

test("estimateReplayTokens uses the meter for messages and chars/3 for system/tools", () => {
	const meter = { estimateMessage: (m) => m.content[0].text.length };
	const input = {
		system: "abcdef",
		tools: [{ name: "t" }],
		messages: [user("abc"), assistant("xyz")]
	};
	// system 6/3=2, tools JSON `[{"name":"t"}]` is 13 chars → ceil(13/3)=5, messages 3+3=6
	assert.equal(estimateReplayTokens(meter, input), 13);
});

test("estimateReplayTokens tolerates a missing meter and null messages", () => {
	const input = { messages: [null, user("abc")] };
	assert.ok(estimateReplayTokens(null, input) > 0);
	assert.equal(estimateReplayTokens(null, { messages: [] }), 0);
});
