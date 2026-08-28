import { describe, it, expect, vi, afterEach } from "vitest";
import { callLlm, LlmApiError } from "../src/llmClient";

const BASE_URL = "https://sberecognition.tzuchi-org.tw/functions/v1/llm-proxy/v1";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("callLlm", () => {
  it("returns the message content on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "1|||hello world" } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callLlm("prompt text", BASE_URL, "sk-test", "Qwen3.6-35B-A3B", 60000);

    expect(result).toBe("1|||hello world");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/chat/completions`);
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("Qwen3.6-35B-A3B");
    expect(body.messages).toEqual([{ role: "user", content: "prompt text" }]);
  });

  it("raises immediately when the API key is missing", async () => {
    await expect(callLlm("prompt text", BASE_URL, "", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(LlmApiError);
    await expect(callLlm("prompt text", BASE_URL, "", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /LLM_PROXY_API_KEY/
    );
  });

  it("raises on an authentication error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "invalid key" }, 401)));
    await expect(callLlm("prompt text", BASE_URL, "sk-bad", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /金鑰無效/
    );
  });

  it("raises on a rate-limit error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited" }, 429)));
    await expect(callLlm("prompt text", BASE_URL, "sk-test", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /速率限制/
    );
  });

  it("extracts the retry-after delay from a rate-limit error body", async () => {
    const resetAt = new Date(Date.now() + 10_000).toISOString().slice(0, 19).replace("T", " ");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: `Rate limit exceeded. Limit resets at: ${resetAt} UTC` } }),
          { status: 429 }
        )
      )
    );

    let caught: unknown;
    try {
      await callLlm("prompt text", BASE_URL, "sk-test", "Qwen3.6-35B-A3B", 60000);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmApiError);
    expect((caught as LlmApiError).retryAfterMs).toBeGreaterThan(0);
    expect((caught as LlmApiError).retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it("raises on a connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    await expect(callLlm("prompt text", BASE_URL, "sk-test", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /無法連線/
    );
  });
});
