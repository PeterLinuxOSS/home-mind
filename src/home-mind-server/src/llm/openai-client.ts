import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";
import { buildSystemPromptText } from "./prompts.js";
import { TOOL_DEFINITIONS, toOpenAITools } from "./tool-definitions.js";
import { handleToolCall, extractAndStoreFacts, type ToolContext } from "./tool-handler.js";
import { withTokenCap, usesMaxCompletionTokens } from "./token-cap.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatError,
  StreamCallback,
  IChatEngine,
  IFactExtractor,
} from "./interface.js";

type FunctionToolCall = OpenAI.ChatCompletionMessageFunctionToolCall;

const OPENAI_TOOLS = toOpenAITools(TOOL_DEFINITIONS);

/**
 * Hard cap on tool round-trips per user message. A model that loops (repeatedly
 * re-searching entities, retrying a tool it misreads as failing) otherwise runs
 * until the HA integration's 120s client timeout with nothing to show for it —
 * and on a metered API, at the user's expense. On the last iteration we re-ask
 * with tool calling disabled so there is still a written answer.
 */
const MAX_TOOL_ITERATIONS = 8;

/** Provider-specific tool-call payload outside the OpenAI schema (Gemini's thought signature). */
function extraContentOf(tc: object): unknown {
  return (tc as { extra_content?: unknown }).extra_content;
}

export class OpenAIChatEngine implements IChatEngine {
  private client: OpenAI;
  private memory: IMemoryStore;
  private conversations: IConversationStore;
  private extractor: IFactExtractor;
  private ha: HomeAssistantClient;
  private scanner: DeviceScanner;
  private topology: TopologyScanner;
  private config: Config;

  constructor(
    config: Config,
    memory: IMemoryStore,
    conversations: IConversationStore,
    extractor: IFactExtractor,
    ha: HomeAssistantClient,
    scanner: DeviceScanner,
    topology: TopologyScanner
  ) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/hoornet/home-mind",
        "X-Title": "Home Mind",
      },
    });
    this.memory = memory;
    this.conversations = conversations;
    this.extractor = extractor;
    this.ha = ha;
    this.scanner = scanner;
    this.topology = topology;
  }

  async chat(
    request: ChatRequest,
    onChunk?: StreamCallback
  ): Promise<ChatResponse> {
    const { message, userId, conversationId, isVoice = false, customPrompt } = request;
    // A nonce for this turn, and ONE shared context for the whole turn:
    // forget_memory writes forgetTargets back onto it, so a fresh object per
    // tool call would lose them.
    const turnId = randomUUID();
    const toolCtx: ToolContext = { conversationId, turnId, userId, memory: this.memory };
    const toolsUsed: string[] = [];

    // 1. Load user's memory
    const facts = await this.memory.getFactsWithinTokenLimit(
      userId,
      this.config.memoryTokenLimit,
      message
    );
    const factContents = facts.map((f) => f.content);
    if (this.config.logLevel === "debug") {
      const approxTokens = Math.ceil(factContents.join(" ").length / 4);
      console.debug(
        `[recall] userId=${userId} factCount=${factContents.length} tokens=${approxTokens}`
      );
    }

    // 2. Refresh device profiles and home layout if stale, then build system prompt
    await Promise.all([this.scanner.refreshIfStale(), this.topology.refreshIfStale()]);
    const deviceCheatSheet = this.scanner.hasProfiles()
      ? this.scanner.formatCheatSheet()
      : undefined;
    const homeLayout = this.topology.hasLayout() ? this.topology.formatSection() : undefined;
    const systemPrompt = buildSystemPromptText(factContents, isVoice, customPrompt, deviceCheatSheet, homeLayout);

    // 3. Load conversation history
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (conversationId) {
      const history = await this.conversations.getConversationHistory(conversationId, 10);
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // 4. Add current user message
    messages.push({ role: "user", content: message });

    if (conversationId) {
      this.conversations.storeMessage(conversationId, userId, "user", message);
    }

    // 5. Stream and handle tool call loop
    let result = await this.streamCompletion(messages, isVoice, onChunk);

    let iterations = 0;
    // Not finish_reason: Gemini reports "stop" on a turn that calls tools.
    while (result.toolCalls.length > 0) {
      iterations++;

      if (this.config.logLevel === "debug") {
        console.debug(`[llm] tool calls sent back: ${JSON.stringify(result.toolCalls)}`);
      }
      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls,
      });

      // Execute all tool calls in parallel
      const toolPromises = result.toolCalls.map(async (tc: FunctionToolCall) => {
        toolsUsed.push(tc.function.name);

        // Small local models routinely emit truncated or non-JSON arguments.
        // Hand that back as a tool error the model can recover from — throwing
        // here would reject the whole Promise.all and fail the user's request.
        let args: Record<string, unknown>;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          console.warn(
            `[tool] ${tc.function.name} got unparseable arguments: ${tc.function.arguments}`
          );
          return {
            role: "tool" as const,
            tool_call_id: tc.id,
            content: JSON.stringify({
              error:
                `Arguments for ${tc.function.name} were not valid JSON and could not be read. ` +
                `Call the tool again with valid JSON arguments.`,
            }),
          };
        }

        const toolResult = await handleToolCall(this.ha, tc.function.name, args, toolCtx);
        return {
          role: "tool" as const,
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult, null, 2),
        };
      });

      const toolResults = await Promise.all(toolPromises);
      messages.push(...toolResults);

      // Continue streaming. On the final allowed iteration, disable tool calling
      // so the model has to answer in words rather than loop again.
      const forceAnswer = iterations >= MAX_TOOL_ITERATIONS;
      if (forceAnswer) {
        console.warn(
          `[llm] tool loop hit ${MAX_TOOL_ITERATIONS} iterations — forcing a final answer`
        );
      }
      result = await this.streamCompletion(messages, isVoice, onChunk, forceAnswer);
      if (forceAnswer) break;
    }

    // Gemini often ends a turn after a successful tool call without a word; a
    // fixed reply is a round-trip faster than asking the model again.
    if (result.text === "" && result.toolCalls.length === 0 && toolsUsed.length > 0) {
      result = { ...result, text: this.config.actionDoneReply };
      onChunk?.(result.text);
    }

    const responseText = result.text;

    // 6. Store assistant response
    if (conversationId && responseText) {
      this.conversations.storeMessage(conversationId, userId, "assistant", responseText);
    }

    // 7. Extract and store facts (fire-and-forget)
    extractAndStoreFacts(
      this.memory,
      this.extractor,
      userId,
      message,
      responseText,
      toolCtx.forgetTargets
    ).catch((err) => console.error("Fact extraction failed:", err));

    // 8. If the model produced no usable response, attach a structured error
    // so the HA integration can surface a useful hint instead of the generic
    // "I received your request but got no response." fallback. The `finish_reason`
    // from the final stream tells us which diagnostic applies.
    const error = responseText === "" && result.toolCalls.length === 0
      ? this.classifyEmptyResponse(result.finishReason)
      : undefined;

    return {
      response: responseText,
      toolsUsed,
      factsLearned: 0,
      ...(error ? { error } : {}),
    };
  }

  private classifyEmptyResponse(finishReason: string | null): ChatError {
    if (finishReason === "length") {
      // On OpenAI's newer models the output cap also covers hidden reasoning
      // tokens, so a reasoning-heavy turn can exhaust it before writing a single
      // visible word. That is a different problem from a prompt being too large,
      // and it deserves a different instruction.
      const hint = usesMaxCompletionTokens(this.config.llmModel)
        ? "The model used its entire output budget on internal reasoning and had " +
          "none left for the answer. Try a non-reasoning model, or a lower " +
          "reasoning effort if your provider exposes one."
        : "Response was cut off at max_tokens before the model finished. " +
          "If you're seeing this often, the conversation prompt may be too large " +
          "for the model's output budget — try a model with more output tokens.";
      return { code: "MAX_TOKENS_TRUNCATED", hint };
    }
    if (finishReason === "content_filter") {
      return {
        code: "CONTENT_FILTERED",
        hint:
          "The provider blocked the response (content filter). " +
          "If this happens on benign smart-home commands, try a different model.",
      };
    }
    return {
      code: "EMPTY_CONTENT",
      hint:
        "The model returned no text and no tool calls. " +
        "If you're routing through an OpenAI-compatible shim/proxy, verify it streams " +
        "OpenAI-format SSE chunks. For local models, ensure the model emits a final " +
        "answer rather than just thinking. For the fact extractor specifically, set " +
        "OPENAI_RESPONSE_FORMAT=json_object on picky providers (e.g. some Ollama models).",
    };
  }

  private async streamCompletion(
    messages: OpenAI.ChatCompletionMessageParam[],
    isVoice: boolean,
    onChunk?: StreamCallback,
    disableTools = false
  ): Promise<{
    text: string;
    finishReason: string | null;
    toolCalls: FunctionToolCall[];
  }> {
    const stream = await withTokenCap(
      this.config.llmModel,
      isVoice ? 500 : 2048,
      (cap) =>
        this.client.chat.completions.create({
          model: this.config.llmModel,
          ...cap,
          messages,
          tools: OPENAI_TOOLS,
          // Keep the tool list in the request (history already references it) but
          // stop the model from issuing more calls.
          ...(disableTools ? { tool_choice: "none" as const } : {}),
          ...(this.config.reasoningEffort
            ? { reasoning_effort: this.config.reasoningEffort }
            : {}),
          stream: true,
        })
    );

    let text = "";
    let finishReason: string | null = null;

    // Tool calls in arrival order. OpenAI streams one call over several deltas
    // sharing an `index`; Gemini sends each call whole with its own `id` and no
    // `index`, so a new id always opens a new call.
    const calls: { id: string; name: string; arguments: string; extraContent?: unknown }[] = [];
    const byIndex = new Map<number, number>();
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (this.config.logLevel === "debug" && choice.delta?.tool_calls) {
        console.debug(`[llm] tool-call chunk: ${JSON.stringify(chunk)}`);
      }

      // Accumulate text
      if (choice.delta?.content) {
        text += choice.delta.content;
        if (onChunk) {
          onChunk(choice.delta.content);
        }
      }

      // Accumulate tool call deltas
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const pos = tc.index === undefined ? calls.length - 1 : byIndex.get(tc.index);
          const existing = pos === undefined ? undefined : calls[pos];
          if (existing && !(tc.id && existing.id && tc.id !== existing.id)) {
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            existing.extraContent ??= extraContentOf(tc);
          } else {
            calls.push({
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
              extraContent: extraContentOf(tc),
            });
            if (tc.index !== undefined) byIndex.set(tc.index, calls.length - 1);
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // Convert accumulated tool calls to the expected format
    const toolCalls: FunctionToolCall[] = [];
    for (const tc of calls) {
      toolCalls.push({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
        // Gemini 3 rejects the next turn unless its thought signature comes back.
        ...(tc.extraContent !== undefined ? { extra_content: tc.extraContent } : {}),
      });
    }

    if (this.config.logLevel === "debug") {
      console.debug(
        `[llm] stream end: finish=${finishReason} text=${text.length} chars toolCalls=${toolCalls.length}`
      );
    }

    return { text, finishReason, toolCalls };
  }
}
