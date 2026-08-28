import { LlmApiError } from "./llmClient";

export class GeminiApiError extends LlmApiError {}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
}

export async function callGemini(
  prompt: string,
  apiKey: string,
  model: string,
  timeoutMs: number
): Promise<string> {
  if (!apiKey) {
    throw new GeminiApiError("未設定 GEMINI_API_KEY，請確認 Cloudflare secret 已設定");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal,
      }
    );
  } catch (e) {
    throw new GeminiApiError(`無法連線 Gemini API：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new GeminiApiError(`Gemini API 金鑰無效或無權限，請確認設定：${await response.text()}`);
  }
  if (response.status === 429) {
    throw new GeminiApiError(`Gemini API 已達速率限制，請稍後再試：${await response.text()}`);
  }
  if (response.status >= 400) {
    throw new GeminiApiError(`Gemini API 錯誤（status ${response.status}）：${await response.text()}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new GeminiApiError(`Gemini API 回應格式異常，缺少預期的內容欄位：${JSON.stringify(data)}`);
  }
  return text;
}
