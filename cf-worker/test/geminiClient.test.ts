import { describe, it, expect, vi, afterEach } from "vitest";
import { callGemini, GeminiApiError } from "../src/geminiClient";
import { LlmApiError } from "../src/llmClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("callGemini", () => {
  it("returns the response text on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "1|||hello world" }] } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callGemini("prompt text", "test-key", "gemini-3.6-flash", 60000);

    expect(result).toBe("1|||hello world");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("gemini-3.6-flash:generateContent");
    expect(url).toContain("key=test-key");
    const body = JSON.parse(init.body as string);
    expect(body.contents).toEqual([{ parts: [{ text: "prompt text" }] }]);
  });

  it("is a kind of LlmApiError so the shared retry loop recognizes it", async () => {
    await expect(callGemini("prompt", "", "gemini-3.6-flash", 60000)).rejects.toBeInstanceOf(LlmApiError);
  });

  it("raises immediately when the API key is missing", async () => {
    await expect(callGemini("prompt text", "", "gemini-3.6-flash", 60000)).rejects.toThrow(GeminiApiError);
    await expect(callGemini("prompt text", "", "gemini-3.6-flash", 60000)).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("raises on an authentication error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "invalid key" }, 401)));
    await expect(callGemini("prompt text", "bad-key", "gemini-3.6-flash", 60000)).rejects.toThrow(/金鑰無效/);
  });

  it("raises on a rate-limit error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited" }, 429)));
    await expect(callGemini("prompt text", "test-key", "gemini-3.6-flash", 60000)).rejects.toThrow(/速率限制/);
  });

  it("raises on a connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    await expect(callGemini("prompt text", "test-key", "gemini-3.6-flash", 60000)).rejects.toThrow(/無法連線/);
  });

  it("raises when the response is missing the expected text field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ candidates: [] })));
    await expect(callGemini("prompt text", "test-key", "gemini-3.6-flash", 60000)).rejects.toThrow(/回應格式異常/);
  });
});
