import type { ProviderStreams } from "../types.ts";
import { type LazyApiCapabilities, lazyApi } from "./lazy.ts";

export const openAIResponsesApi = (capabilities?: LazyApiCapabilities): ProviderStreams =>
	lazyApi(() => import("./openai-responses.ts"), capabilities);
