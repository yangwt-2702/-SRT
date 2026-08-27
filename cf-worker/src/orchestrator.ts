import { Cue, serializeSrt } from "./srt";
import { buildBatchPrompt, buildRetryPrompt, GlossaryRow } from "./promptBuilder";
import { parseLlmResponse, TranslationParseError } from "./responseParser";
import { LlmApiError } from "./llmClient";
import { checkConsistency } from "./glossaryCheck";

export const FAILURE_TEXT = "[翻譯失敗-請人工確認]";

export interface BatchOutcome {
  translated: Cue[];
  warning: string | null;
  pendingRaw: Array<[string, string]>;
  newContextTail: Array<[string, string]>;
}

export async function runOneBatch(params: {
  batch: Cue[];
  glossary: GlossaryRow[];
  contextTail: Array<[string, string]>;
  maxRetries: number;
  callLlm: (prompt: string) => Promise<string>;
}): Promise<BatchOutcome> {
  const { batch, glossary, contextTail, maxRetries, callLlm } = params;
  const expectedIndices = batch.map((c) => c.index);
  const originalPrompt = buildBatchPrompt(batch, glossary, contextTail);
  let prompt = originalPrompt;
  let parsed = null;
  let lastError = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = await callLlm(prompt);
      parsed = parseLlmResponse(raw, expectedIndices);
      break;
    } catch (e) {
      if (e instanceof TranslationParseError || e instanceof LlmApiError) {
        lastError = e.message;
        prompt = buildRetryPrompt(originalPrompt, lastError);
      } else {
        throw e;
      }
    }
  }

  if (parsed === null) {
    return {
      translated: batch.map((cue) => ({ ...cue, text: FAILURE_TEXT })),
      warning: `批次 ${batch[0].index}-${batch[batch.length - 1].index} 翻譯失敗（${lastError}），請人工確認`,
      pendingRaw: [],
      newContextTail: [],
    };
  }

  const translated = batch.map((cue, i) => ({ ...cue, text: parsed![i].text }));
  const pendingRaw = parsed.flatMap((line) => line.unsure);
  const pairs: Array<[string, string]> = batch.map((cue, i) => [cue.text, parsed![i].text]);

  return {
    translated,
    warning: null,
    pendingRaw,
    newContextTail: pairs.slice(-3),
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
  const warnings = [...params.warnings, ...checkConsistency(zhCues, translated, glossary)];

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
