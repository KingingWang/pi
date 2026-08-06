import { afterEach, describe, expect, it, vi } from "vitest";
import {
	stream as streamOpenAICompletions,
	streamSimple as streamOpenAICompletionsSimple,
} from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import { contentText } from "../src/index.ts";
import { createModels } from "../src/models.ts";
import { deepseekProvider } from "../src/providers/deepseek.ts";
import type { AssistantMessageEvent, Context } from "../src/types.ts";

interface CapturedCall {
	method: string;
	url: string;
	body?: unknown;
}

function completionResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function createContext(): Context {
	return {
		systemPrompt: "Reply exactly as requested.",
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
}

describe("OpenAI Completions non-streaming mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("issues a single non-streaming completion request through Models", async () => {
		const calls: CapturedCall[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			calls.push({
				method: (init?.method ?? "GET").toUpperCase(),
				url: typeof _input === "string" ? _input : String(_input),
				...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
			});
			return completionResponse({
				id: "chatcmpl_1",
				object: "chat.completion",
				created: 0,
				model: "deepseek-v4-flash",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "hello non-streaming" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
			});
		});

		const models = createModels();
		models.setProvider(deepseekProvider());
		const model = models.getModel("deepseek", "deepseek-v4-flash");
		if (!model) throw new Error("DeepSeek model deepseek-v4-flash is not available");

		const events: AssistantMessageEvent[] = [];
		const stream = models.streamSimple(model, createContext(), {
			apiKey: "test-key",
			nonStreaming: true,
		});
		for await (const event of stream) events.push(event);
		const response = await stream.result();

		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(contentText(response.content)).toBe("hello non-streaming");
		expect(response.usage.totalTokens).toBe(12);
		expect(calls[0].body).toMatchObject({ model: "deepseek-v4-flash", stream: false });
		expect(calls[0].body).not.toMatchObject({ stream_options: expect.anything() });
	});

	it("parses tool calls from a non-streaming response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			completionResponse({
				id: "chatcmpl_tool",
				object: "chat.completion",
				created: 0,
				model: "deepseek-v4-flash",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "get_weather",
										arguments: '{"city":"beijing"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
		);

		const model = getModel("deepseek", "deepseek-v4-flash");
		const stream = streamOpenAICompletionsSimple(model, createContext(), {
			apiKey: "test-key",
			nonStreaming: true,
		});
		for await (const _event of stream) {
			// Drain the stream so result() resolves.
		}
		const response = await stream.result();

		expect(response.stopReason, response.errorMessage).toBe("toolUse");
		expect(response.content).toHaveLength(1);
		const toolCall = response.content[0];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type === "toolCall") {
			expect(toolCall.name).toBe("get_weather");
			expect(toolCall.arguments).toEqual({ city: "beijing" });
		}
	});

	it("parses reasoning content from a non-streaming response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			completionResponse({
				id: "chatcmpl_reason",
				object: "chat.completion",
				created: 0,
				model: "deepseek-v4-flash",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: "the answer",
							reasoning_content: "thinking hard",
						},
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
			}),
		);

		const model = getModel("deepseek", "deepseek-v4-flash");
		const stream = streamOpenAICompletions(model, createContext(), {
			apiKey: "test-key",
			nonStreaming: true,
		});
		for await (const _event of stream) {
			// Drain the stream so result() resolves.
		}
		const response = await stream.result();

		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(contentText(response.content)).toBe("the answer");
		const thinking = response.content.find((block) => block.type === "thinking");
		expect(thinking).toBeDefined();
		if (thinking?.type === "thinking") {
			expect(thinking.thinking).toBe("thinking hard");
		}
	});

	it("rejects a non-streaming response without a completion choice", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			completionResponse({
				id: "chatcmpl_empty",
				object: "chat.completion",
				created: 0,
				model: "deepseek-v4-flash",
				choices: [],
			}),
		);

		const model = getModel("deepseek", "deepseek-v4-flash");
		const stream = streamOpenAICompletions(model, createContext(), {
			apiKey: "test-key",
			nonStreaming: true,
		});
		for await (const _event of stream) {
			// Drain the stream so result() resolves.
		}
		const response = await stream.result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("omitted its first choice");
	});

	it("keeps streaming requests streaming by default", async () => {
		let capturedBody: unknown;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const model = getModel("deepseek", "deepseek-v4-flash");
		const stream = streamOpenAICompletions(model, createContext(), { apiKey: "test-key" });
		for await (const _event of stream) {
			// Drain the stream so result() resolves.
		}

		expect(capturedBody).toMatchObject({ stream: true });
		expect(capturedBody).toMatchObject({ stream_options: { include_usage: true } });
	});
});
