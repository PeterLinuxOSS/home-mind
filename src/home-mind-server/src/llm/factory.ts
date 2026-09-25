import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";
import type { IChatEngine, IFactExtractor } from "./interface.js";
import { LLMClient } from "./client.js";
import { OpenAIChatEngine } from "./openai-client.js";
import { FactExtractor } from "../memory/extractor.js";
import { OpenAIFactExtractor } from "../memory/openai-extractor.js";

/** Google's OpenAI-compatible endpoint for the Gemini API. */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export function createChatEngine(
  config: Config,
  memory: IMemoryStore,
  conversations: IConversationStore,
  extractor: IFactExtractor,
  ha: HomeAssistantClient,
  scanner: DeviceScanner,
  topology: TopologyScanner
): IChatEngine {
  switch (config.llmProvider) {
    case "openai":
      return new OpenAIChatEngine(config, memory, conversations, extractor, ha, scanner, topology);
    case "ollama":
      return new OpenAIChatEngine(
        {
          ...config,
          openaiApiKey: "ollama",
          openaiBaseUrl: config.ollamaBaseUrl ?? "http://localhost:11434/v1",
        },
        memory,
        conversations,
        extractor,
        ha,
        scanner,
        topology
      );
    case "gemini":
      return new OpenAIChatEngine(
        { ...config, openaiApiKey: config.geminiApiKey, openaiBaseUrl: GEMINI_BASE_URL },
        memory,
        conversations,
        extractor,
        ha,
        scanner,
        topology
      );
    case "anthropic":
      return new LLMClient(config, memory, conversations, extractor, ha, scanner, topology);
  }
}

export function createFactExtractor(config: Config): IFactExtractor {
  switch (config.llmProvider) {
    case "openai":
      return new OpenAIFactExtractor(
        config.openaiApiKey!,
        config.llmModel,
        config.openaiBaseUrl,
        config.openaiResponseFormat,
        config.openaiMaxTokens,
        config.reasoningEffort
      );
    case "ollama":
      return new OpenAIFactExtractor(
        "ollama",
        config.llmModel,
        config.ollamaBaseUrl ?? "http://localhost:11434/v1",
        config.openaiResponseFormat,
        config.openaiMaxTokens
      );
    case "gemini":
      return new OpenAIFactExtractor(
        config.geminiApiKey!,
        config.llmModel,
        GEMINI_BASE_URL,
        config.openaiResponseFormat ?? "json_object",
        config.openaiMaxTokens,
        config.reasoningEffort
      );
    case "anthropic":
      return new FactExtractor(config.anthropicApiKey!, config.llmModel);
  }
}
