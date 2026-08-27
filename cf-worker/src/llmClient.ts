export class LlmApiError extends Error {}

const MAX_RESPONSE_TOKENS = 8192;

export async function callLlm(
  prompt: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number
): Promise<string> {
  if (!apiKey) {
    throw new LlmApiError("未設定 LLM_PROXY_API_KEY，請確認 Cloudflare secret 已設定");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: MAX_RESPONSE_TOKENS,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new LlmApiError(`無法連線 LLM 代理伺服器：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new LlmApiError(`LLM 代理 API 金鑰無效或無權限，請確認設定：${await response.text()}`);
  }
  if (response.status === 429) {
    throw new LlmApiError(`LLM 代理已達速率限制，請稍後再試：${await response.text()}`);
  }
  if (response.status >= 400) {
    throw new LlmApiError(`LLM 代理錯誤（status ${response.status}）：${await response.text()}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LlmApiError(`LLM 代理回應格式異常，缺少預期的內容欄位：${JSON.stringify(data)}`);
  }
  return content;
}
