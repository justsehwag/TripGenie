import { describe, it, expect, afterEach } from "vitest";
import { loadAwsConfig } from "@/lib/config";

/**
 * Feature: realtime-ai-integration - non-secret Bedrock config (Req 3.4).
 *
 * loadAwsConfig().bedrock.{modelId,region} resolve documented defaults when
 * the env vars are unset, and read from the environment when set. Loading
 * never throws. No secret is read here (access is via the Amplify role).
 */

const BEDROCK_ENV_KEYS = ["BEDROCK_MODEL_ID", "BEDROCK_REGION", "AWS_REGION"] as const;

describe("Feature: realtime-ai-integration, Bedrock config", () => {
  // Snapshot and restore only the env keys this suite mutates, so the suite
  // is deterministic and leaves process.env untouched for other tests.
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of BEDROCK_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(saved, key)) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        delete saved[key];
      }
    }
  });

  function clearBedrockEnv(): void {
    for (const key of BEDROCK_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  function setEnv(key: (typeof BEDROCK_ENV_KEYS)[number], value: string): void {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) {
      saved[key] = process.env[key];
    }
    process.env[key] = value;
  }

  it("resolves documented defaults when env vars are unset", () => {
    clearBedrockEnv();
    const config = loadAwsConfig();
    expect(config.bedrock.modelId).toBe(
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    );
    expect(config.bedrock.region).toBe("us-east-1");
  });

  it("reads modelId and region from the environment when set", () => {
    clearBedrockEnv();
    setEnv("BEDROCK_MODEL_ID", "anthropic.claude-3-sonnet-20240229-v1:0");
    setEnv("BEDROCK_REGION", "eu-west-1");
    const config = loadAwsConfig();
    expect(config.bedrock.modelId).toBe(
      "anthropic.claude-3-sonnet-20240229-v1:0"
    );
    expect(config.bedrock.region).toBe("eu-west-1");
  });

  it("falls back to AWS_REGION when BEDROCK_REGION is unset", () => {
    clearBedrockEnv();
    setEnv("AWS_REGION", "ap-southeast-2");
    const config = loadAwsConfig();
    expect(config.bedrock.region).toBe("ap-southeast-2");
  });

  it("prefers BEDROCK_REGION over AWS_REGION when both are set", () => {
    clearBedrockEnv();
    setEnv("AWS_REGION", "ap-southeast-2");
    setEnv("BEDROCK_REGION", "us-west-2");
    const config = loadAwsConfig();
    expect(config.bedrock.region).toBe("us-west-2");
  });

  it("treats blank env values as unset and uses defaults", () => {
    clearBedrockEnv();
    setEnv("BEDROCK_MODEL_ID", "   ");
    setEnv("BEDROCK_REGION", "   ");
    const config = loadAwsConfig();
    expect(config.bedrock.modelId).toBe(
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    );
    expect(config.bedrock.region).toBe("us-east-1");
  });

  it("never throws at load when env vars are absent", () => {
    clearBedrockEnv();
    expect(() => loadAwsConfig()).not.toThrow();
  });
});
