import { Cue, serializeSrt } from "./srt";
import { buildBatchPrompt, buildRetryPrompt, GlossaryRow } from "./promptBuilder";
import { parseLlmResponse, ParsedLine, TranslationParseError } from "./responseParser";
import { LlmApiError } from "./llmClient";

export const FAILURE_TEXT = "[翻譯失敗-請人工確認]";
const MAX_RATE_LIMIT_BACKOFF_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BatchOutcome {
  translated: Cue[];
  warning: string | null;
  pendingRaw: Array<[string, string]>;
  newContextTail: Array<[string, string]>;
}

interface RunOneBatchParams {
  batch: Cue[];
  glossary: GlossaryRow[];
  contextTail: Array<[string, string]>;
  maxRetries: number;
  callLlm: (prompt: string) => Promise<string>;
  // Tried, using the same prompt/format contract, only once the primary
  // model (and bisection, where applicable) has been exhausted for a given
  // batch — a different provider so it isn't hit by the primary's own
  // outage/rate-limit, kept as a last resort rather than the default path.
  callFallbackLlm?: (prompt: string) => Promise<string>;
}

function batchLabel(batch: Cue[]): string {
  return batch.length === 1 ? `第 ${batch[0].index} 條` : `批次 ${batch[0].index}-${batch[batch.length - 1].index}`;
}

function buildSuccessOutcome(batch: Cue[], parsed: ParsedLine[]): BatchOutcome {
  const translated = batch.map((cue, i) => ({ ...cue, text: parsed[i].text }));
  const pendingRaw = parsed.flatMap((line) => line.unsure);
  const pairs: Array<[string, string]> = batch.map((cue, i) => [cue.text, parsed[i].text]);
  return { translated, warning: null, pendingRaw, newContextTail: pairs.slice(-3) };
}

async function attemptTranslateBatch(
  params: RunOneBatchParams
): Promise<{ parsed: ParsedLine[] | null; lastError: string; wasFormatIssue: boolean }> {
  const { batch, glossary, contextTail, maxRetries, callLlm } = params;
  const originalPrompt = buildBatchPrompt(batch, glossary, contextTail);
  let prompt = originalPrompt;
  let lastError = "";
  let wasFormatIssue = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = await callLlm(prompt);
      return { parsed: parseLlmResponse(raw, batch), lastError: "", wasFormatIssue: false };
    } catch (e) {
      if (e instanceof TranslationParseError || e instanceof LlmApiError) {
        lastError = e.message;
        wasFormatIssue = e instanceof TranslationParseError;
        prompt = buildRetryPrompt(originalPrompt, lastError);
        const isLastAttempt = attempt === maxRetries - 1;
        if (!isLastAttempt && e instanceof LlmApiError && e.retryAfterMs) {
          await sleep(Math.min(e.retryAfterMs, MAX_RATE_LIMIT_BACKOFF_MS));
        }
      } else {
        throw e;
      }
    }
  }
  return { parsed: null, lastError, wasFormatIssue };
}

export async function runOneBatch(params: RunOneBatchParams): Promise<BatchOutcome> {
  const { batch, contextTail, callFallbackLlm } = params;
  const { parsed, lastError, wasFormatIssue } = await attemptTranslateBatch(params);

  if (parsed !== null) {
    return buildSuccessOutcome(batch, parsed);
  }

  // A formatting/index-mismatch failure on a multi-cue batch is often
  // caused by one awkward cue, or the batch simply being too long for the
  // model to keep 1:1 line alignment on — isolate it by bisecting instead
  // of discarding every cue in the batch. A rate-limit/API-level failure
  // would hit both halves just as hard, so don't bother splitting for those.
  if (wasFormatIssue && batch.length > 1) {
    const mid = Math.ceil(batch.length / 2);
    const first = await runOneBatch({ ...params, batch: batch.slice(0, mid) });
    const second = await runOneBatch({
      ...params,
      batch: batch.slice(mid),
      contextTail: first.newContextTail.length ? first.newContextTail : contextTail,
    });
    return {
      translated: [...first.translated, ...second.translated],
      warning: [first.warning, second.warning].filter((w): w is string => Boolean(w)).join(" ") || null,
      pendingRaw: [...first.pendingRaw, ...second.pendingRaw],
      newContextTail: second.newContextTail.length ? second.newContextTail : first.newContextTail,
    };
  }

  // Last resort before giving up on this batch entirely: hand the exact
  // same prompt/format contract to a different model/provider, which won't
  // be affected by whatever just made the primary one fail.
  if (callFallbackLlm) {
    const fallback = await attemptTranslateBatch({ ...params, callLlm: callFallbackLlm });
    if (fallback.parsed !== null) {
      return {
        ...buildSuccessOutcome(batch, fallback.parsed),
        warning: `${batchLabel(batch)} 主要翻譯服務失敗（${lastError}），已由備援模型完成翻譯，請留意用詞一致性`,
      };
    }
  }

  return {
    translated: batch.map((cue) => ({ ...cue, text: FAILURE_TEXT })),
    warning: `${batchLabel(batch)} 翻譯失敗（${lastError}），請人工確認`,
    pendingRaw: [],
    newContextTail: [],
  };
}

export interface FinalResult {
  filename: string;
  srt: string;
  warnings: string[];
  // snake_case: serialized straight into the JSON response frontend/app.js
  // reads, matching the original Python API's `pending_terms` key.
  pending_terms: Array<{ term: string; suggested_fix: string }>;
}

export async function finishTranslation(params: {
  videoTitle: string;
  zhCues: Cue[];
  translated: Cue[];
  warnings: string[];
  pendingRaw: Array<[string, string]>;
  glossary: GlossaryRow[];
  insertPendingTerm: (p: {
    term: string;
    stage: string;
    context: string;
    suggestedFix: string;
    videoTitle: string;
  }) => Promise<unknown>;
}): Promise<FinalResult> {
  const { videoTitle, zhCues, translated, glossary, insertPendingTerm } = params;
  // Glossary-consistency nitpicks ("原文含鎖定詞...請人工確認") are deliberately not
  // surfaced here: a human proofreader reviews every translation after this
  // pipeline, so these warnings were pure noise for them. See
  // feedback_proofreader_workflow memory.
  const warnings = [...params.warnings];

  const zhTexts = zhCues.map((c) => c.text);
  const glossaryTerms = new Set(glossary.map((row) => row.chinese).filter((v): v is string => Boolean(v)));
  const seenTerms = new Set<string>();
  const pendingTerms: Array<{ term: string; suggested_fix: string }> = [];

  for (const [zhTerm, suggestedFix] of params.pendingRaw) {
    if (seenTerms.has(zhTerm)) continue;
    seenTerms.add(zhTerm);
    if (glossaryTerms.has(zhTerm)) continue;

    try {
      await insertPendingTerm({
        term: zhTerm,
        stage: "translation",
        context: zhTexts.find((t) => t.includes(zhTerm)) ?? "",
        suggestedFix,
        videoTitle,
      });
      pendingTerms.push({ term: zhTerm, suggested_fix: suggestedFix });
    } catch {
      warnings.push(`待確認詞彙「${zhTerm}」寫入 Drust 失敗，請自行記錄`);
    }
  }

  const outputFilename = `[英文字幕]${videoTitle.replace("[中文字幕]", "")}.srt`;
  return {
    filename: outputFilename,
    srt: serializeSrt(translated),
    warnings,
    pending_terms: pendingTerms,
  };
}
