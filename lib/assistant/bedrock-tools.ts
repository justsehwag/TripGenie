/**
 * Trip Assistant Bedrock Converse client with tool use.
 *
 * SERVER-ONLY. Never import from a `"use client"` module. The AWS SDK is
 * imported dynamically inside the returned function (same pattern as
 * `createBedrockInvoke` in lib/bedrock-model.ts), so importing this module does
 * no AWS work. Credentials resolve through the runtime execution role; nothing
 * secret is read here, and neither credentials nor message text are logged.
 *
 * Requirements: 4.1, 4.2, 4.7, 4.9
 */

import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { awsConfig } from "../config";

export type { ContentBlock };

/** One Converse message. Assistant messages are echoed back unchanged. */
export interface ConverseMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ConverseToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ConverseTurn {
  /** The assistant message exactly as Bedrock returned it (includes toolUse blocks). */
  message: { role: "assistant"; content: ContentBlock[] };
  stopReason: "end_turn" | "tool_use" | "max_tokens" | string;
  toolUses: ConverseToolUse[];
  /** Concatenated text blocks of the assistant message. */
  text: string;
}

export interface ConverseRequestArgs {
  system: string;
  messages: ConverseMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type ConverseFn = (req: ConverseRequestArgs) => Promise<ConverseTurn>;

export const ASSISTANT_TEMPERATURE = 0.2;

/** Optional env override for a tool-capable model; falls back to awsConfig.bedrock. */
function resolveModelId(): string {
  const override = process.env.TRIPGENIE_ASSISTANT_MODEL_ID;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return awsConfig.bedrock.modelId;
}

/**
 * Build the Converse function. Throws (rejects) on SDK error, timeout or abort;
 * the error message never contains request content.
 */
export function createConverseClient(): ConverseFn {
  return async (req: ConverseRequestArgs): Promise<ConverseTurn> => {
    const { BedrockRuntimeClient, ConverseCommand } = await import(
      "@aws-sdk/client-bedrock-runtime"
    );
    const { region } = awsConfig.bedrock;
    const modelId = resolveModelId();
    const client = new BedrockRuntimeClient({ region });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const toolConfig =
        req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                toolSpec: {
                  name: t.name,
                  description: t.description,
                  // DocumentType accepts any JSON value.
                  inputSchema: { json: t.inputSchema as never },
                },
              })),
            }
          : undefined;

      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: req.system }],
          messages: req.messages,
          ...(toolConfig ? { toolConfig } : {}),
          inferenceConfig: { maxTokens: req.maxTokens, temperature: ASSISTANT_TEMPERATURE },
        }),
        { abortSignal: controller.signal },
      );

      const content = response.output?.message?.content;
      if (!Array.isArray(content)) throw new Error("bedrock converse returned no message");

      const toolUses: ConverseToolUse[] = [];
      const textParts: string[] = [];
      for (const block of content) {
        if (typeof block.text === "string" && block.text.length > 0) textParts.push(block.text);
        const tu = block.toolUse;
        if (tu && typeof tu.toolUseId === "string" && typeof tu.name === "string") {
          toolUses.push({ toolUseId: tu.toolUseId, name: tu.name, input: tu.input });
        }
      }

      return {
        message: { role: "assistant", content },
        stopReason: String(response.stopReason ?? "end_turn"),
        toolUses,
        text: textParts.join("\n"),
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    }
  };
}

/**
 * Build the user message that answers a tool round: one `toolResult` block per
 * tool use, in order, with `[{ json }]` content and no `status`.
 */
export function buildToolResultMessage(
  results: Array<{ toolUseId: string; result: unknown }>,
): ConverseMessage {
  return {
    role: "user",
    content: results.map((r) => ({
      toolResult: {
        toolUseId: r.toolUseId,
        content: [{ json: r.result as never }],
      },
    })),
  };
}
