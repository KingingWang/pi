import { afterEach, describe, expect, it, vi } from "vitest";
import {
	stream as streamOpenAIResponses,
	streamSimple as streamOpenAIResponsesSimple,
} from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import { contentText } from "../src/index.ts";
import { createModels } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import type { AssistantMessageEvent, Context } from "../src/types.ts";

const IN_PROGRESS_RESPONSE = {
	id: "resp_bg_1",
	object: "response",
	created_at: 0,
	status: "in_progress",
	model: "gpt-5.4-mini",
	output: [],
};

const COMPLETED_RESPONSE = {
	id: "resp_bg_1",
	object: "response",
	created_at: 0,
	status: "completed",
	model: "gpt-5.4-mini",
	output: [
		{
			id: "msg_bg_1",
			type: "message",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: "hello from background", annotations: [] }],
		},
	],
	usage: {
		input_tokens: 10,
		output_tokens: 2,
		total_tokens: 12,
		input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	},
};

interface CapturedCall {
	method: string;
	url: string;
	body?: unknown;
}

function mockResponsesFetch(calls: CapturedCall[]): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({
			method,
			url,
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
		});

		if (url.endsWith("/responses") && method === "POST") {
			return new Response(JSON.stringify(IN_PROGRESS_RESPONSE), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.endsWith("/responses/resp_bg_1") && method === "GET") {
			return new Response(JSON.stringify(COMPLETED_RESPONSE), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.endsWith("/responses/resp_bg_1/cancel") && method === "POST") {
			return new Response(JSON.stringify(IN_PROGRESS_RESPONSE), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});
}

function createContext(): Context {
	return {
		systemPrompt: "Reply exactly as requested.",
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
}

describe("OpenAI Responses background mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("submits a background response with stream:false and returns a deferred handle", async () => {
		const calls: CapturedCall[] = [];
		mockResponsesFetch(calls);
		const models = createModels();
		models.setProvider(openaiProvider());
		const model = models.getModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("OpenAI model gpt-5.4-mini is not available");

		const events: AssistantMessageEvent[] = [];
		const stream = models.streamSimple(model, createContext(), {
			apiKey: "test-key",
			deferred: true,
			reasoning: "high",
		});
		for await (const event of stream) events.push(event);
		const response = await stream.result();

		expect(response.stopReason, response.errorMessage).toBe("deferred");
		expect(response.deferred?.id).toBe("resp_bg_1");
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "deferred" });
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toMatchObject({
			stream: false,
			background: true,
			model: "gpt-5.4-mini",
		});
	});

	it("redeems a completed background response", async () => {
		const calls: CapturedCall[] = [];
		mockResponsesFetch(calls);
		const models = createModels();
		models.setProvider(openaiProvider());
		const model = models.getModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("OpenAI model gpt-5.4-mini is not available");

		const response = await models.fetchDeferred(
			model,
			{ provider: model.provider, modelId: model.id, api: model.api, id: "resp_bg_1" },
			{ apiKey: "test-key" },
		);

		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(contentText(response.content)).toBe("hello from background");
		expect(response.usage.totalTokens).toBeGreaterThan(0);
		expect(calls.some((call) => call.method === "GET" && call.url.endsWith("/responses/resp_bg_1"))).toBe(true);
	});

	it("cancels a pending background response", async () => {
		const calls: CapturedCall[] = [];
		mockResponsesFetch(calls);
		const models = createModels();
		models.setProvider(openaiProvider());
		const model = models.getModel("openai", "gpt-5.4-mini");
		if (!model) throw new Error("OpenAI model gpt-5.4-mini is not available");

		await models.cancelDeferred(
			model,
			{ provider: model.provider, modelId: model.id, api: model.api, id: "resp_bg_1" },
			{ apiKey: "test-key" },
		);

		expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/cancel"))).toBe(true);
	});

	it("rejects deferred requests for non-OpenAI providers", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		const events: AssistantMessageEvent[] = [];
		const stream = streamOpenAIResponsesSimple(model, createContext(), {
			apiKey: "test-key",
			deferred: true,
		});
		for await (const event of stream) events.push(event);
		const response = await stream.result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("supported only by the OpenAI provider");
	});

	it("keeps streaming requests streaming", async () => {
		let capturedBody: unknown;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const events: AssistantMessageEvent[] = [];
		const stream = streamOpenAIResponses(getModel("openai", "gpt-5.4-mini"), createContext(), { apiKey: "test-key" });
		for await (const event of stream) events.push(event);

		expect(capturedBody).toMatchObject({ stream: true });
		expect(capturedBody).not.toMatchObject({ background: true });
	});
});
