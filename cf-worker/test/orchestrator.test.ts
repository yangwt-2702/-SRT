import { describe, it, expect, vi } from "vitest";
import { runOneBatch, finishTranslation, FAILURE_TEXT } from "../src/orchestrator";
import { Cue, serializeSrt } from "../src/srt";
import { GlossaryRow } from "../src/promptBuilder";
import { LlmApiError } from "../src/llmClient";

const GLOSSARY: GlossaryRow[] = [{ chinese: "志工", english: "volunteer", locked: 1 }];

function cue(index: number, text: string): Cue {
  return { index, start: "00:00:00,000", end: "00:00:01,000", text };
}

describe("runOneBatch", () => {
  it("succeeds on the first attempt", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockResolvedValue("1|||志工開示|||English 1\n2|||第二句|||English 2");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1", "English 2"]);
    expect(outcome.warning).toBeNull();
    expect(outcome.pendingRaw).toEqual([]);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });

  it("retries once then succeeds", async () => {
    const batch = [cue(1, "志工開示")];
    const callLlm = vi
      .fn()
      .mockResolvedValueOnce("only one line, wrong format")
      .mockResolvedValueOnce("1|||志工開示|||English 1");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1"]);
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it("marks every cue failed only when even the bisected singletons can't be parsed", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockResolvedValue("garbled non-conforming output");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });

    expect(outcome.translated.every((c) => c.text === FAILURE_TEXT)).toBe(true);
    expect(outcome.warning).not.toBeNull();
    expect(outcome.newContextTail).toEqual([]);
    // 2 attempts on the whole batch, then 2 more on each bisected singleton.
    expect(callLlm).toHaveBeenCalledTimes(6);
  });

  // Regression test for the real production bug (2026-08-28): a batch-wide
  // response that keeps a clean, sequential index list but has silently
  // shifted content onto the wrong lines (see responseParser.test.ts for the
  // parser-level version). This must be treated as a format failure so it
  // retries/bisects instead of shipping the misaligned text.
  it("rejects a batch response with a clean index list but content shifted onto the wrong lines, and recovers via bisection", async () => {
    const batch = [cue(1, "一年2個月"), cue(2, "蓋那個學校")];
    const callLlm = vi
      .fn()
      // Whole batch: indices are 1,2 in order, but each echo is the OTHER cue's text.
      .mockResolvedValueOnce("1|||蓋那個學校|||was that school built\n2|||一年2個月|||in just one year and two months")
      .mockResolvedValueOnce("1|||蓋那個學校|||was that school built\n2|||一年2個月|||in just one year and two months")
      .mockResolvedValueOnce("1|||一年2個月|||in just one year and two months")
      .mockResolvedValueOnce("2|||蓋那個學校|||was that school built");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual([
      "in just one year and two months",
      "was that school built",
    ]);
    expect(outcome.warning).toBeNull();
  });

  it("bisects a batch that fails as a whole and recovers cues that individually succeed", async () => {
    const batch = [cue(1, "第一句"), cue(2, "第二句")];
    const callLlm = vi
      .fn()
      .mockResolvedValueOnce("garbled whole-batch response")
      .mockResolvedValueOnce("garbled whole-batch response")
      .mockResolvedValueOnce("1|||第一句|||English one")
      .mockResolvedValueOnce("2|||第二句|||English two");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English one", "English two"]);
    expect(outcome.warning).toBeNull();
    expect(callLlm).toHaveBeenCalledTimes(4);
  });

  it("after bisecting, only marks the specific cue that keeps failing, leaving its sibling translated", async () => {
    const batch = [cue(1, "第一句"), cue(2, "第二句")];
    const callLlm = vi
      .fn()
      .mockResolvedValueOnce("garbled whole-batch response")
      .mockResolvedValueOnce("garbled whole-batch response")
      .mockResolvedValueOnce("1|||第一句|||English one")
      .mockResolvedValue("still garbled");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });

    expect(outcome.translated[0].text).toBe("English one");
    expect(outcome.translated[1].text).toBe(FAILURE_TEXT);
    expect(outcome.warning).toContain("2");
  });

  it("does not bisect a persistent rate-limit/API-level failure — bisecting wouldn't help", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockRejectedValue(new LlmApiError("proxy down"));

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });

    expect(outcome.translated.every((c) => c.text === FAILURE_TEXT)).toBe(true);
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it("falls back to a second model when the primary is exhausted, instead of giving up", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockRejectedValue(new LlmApiError("primary proxy down"));
    const callFallbackLlm = vi.fn().mockResolvedValue("1|||志工開示|||English 1\n2|||第二句|||English 2");

    const outcome = await runOneBatch({
      batch,
      glossary: GLOSSARY,
      contextTail: [],
      maxRetries: 2,
      callLlm,
      callFallbackLlm,
    });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1", "English 2"]);
    expect(outcome.warning).toContain("primary proxy down");
    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(callFallbackLlm).toHaveBeenCalledTimes(1);
  });

  it("still gives up to FAILURE_TEXT when both the primary and the fallback fail", async () => {
    const batch = [cue(1, "志工開示")];
    const callLlm = vi.fn().mockRejectedValue(new LlmApiError("primary proxy down"));
    const callFallbackLlm = vi.fn().mockRejectedValue(new LlmApiError("fallback also down"));

    const outcome = await runOneBatch({
      batch,
      glossary: GLOSSARY,
      contextTail: [],
      maxRetries: 2,
      callLlm,
      callFallbackLlm,
    });

    expect(outcome.translated[0].text).toBe(FAILURE_TEXT);
    expect(callFallbackLlm).toHaveBeenCalledTimes(2);
  });

  it("does not call the fallback at all when the primary succeeds", async () => {
    const batch = [cue(1, "志工開示")];
    const callLlm = vi.fn().mockResolvedValue("1|||志工開示|||English 1");
    const callFallbackLlm = vi.fn();

    await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm, callFallbackLlm });

    expect(callFallbackLlm).not.toHaveBeenCalled();
  });

  it("waits out the rate-limit reset before retrying instead of retrying instantly", async () => {
    const batch = [cue(1, "志工開示")];
    const callLlm = vi
      .fn()
      .mockRejectedValueOnce(new LlmApiError("rate limited", 40))
      .mockResolvedValueOnce("1|||志工開示|||English 1");

    const start = Date.now();
    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });
    const elapsed = Date.now() - start;

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1"]);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("skips the wait after the final retry attempt is exhausted (only backs off between attempts)", async () => {
    const batch = [cue(1, "志工開示")];
    const callLlm = vi.fn().mockRejectedValue(new LlmApiError("rate limited", 40));

    const start = Date.now();
    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });
    const elapsed = Date.now() - start;

    expect(outcome.translated.every((c) => c.text === FAILURE_TEXT)).toBe(true);
    // 2 attempts -> exactly one gap between them, not one after each attempt.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(80);
  });

  it("collects UNSURE markers into pendingRaw and the last 3 pairs into newContextTail", async () => {
    const batch = [cue(1, "甲"), cue(2, "乙"), cue(3, "丙"), cue(4, "丁")];
    const callLlm = vi
      .fn()
      .mockResolvedValue(
        "1|||甲|||[[UNSURE:甲詞|Jia term]] one\n2|||乙|||two\n3|||丙|||three\n4|||丁|||four"
      );

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.pendingRaw).toEqual([["甲詞", "Jia term"]]);
    expect(outcome.newContextTail).toEqual([
      ["乙", "two"],
      ["丙", "three"],
      ["丁", "four"],
    ]);
  });
});

describe("finishTranslation", () => {
  const zhCues = [cue(1, "守護生命"), cue(2, "新詞彙")];

  it("skips inserting a pending term that's already in the glossary", async () => {
    const glossary: GlossaryRow[] = [{ chinese: "守護生命", english: "Protect Life", locked: 1 }];
    const translated = [cue(1, "Protect Life talk"), cue(2, "New term test")];
    const insertPendingTerm = vi.fn().mockResolvedValue({ id: 1 });

    const result = await finishTranslation({
      videoTitle: "test",
      zhCues,
      translated,
      warnings: [],
      pendingRaw: [
        ["守護生命", "Protect Life"],
        ["新詞彙", "New term"],
      ],
      glossary,
      insertPendingTerm,
    });

    const insertedTerms = result.pending_terms.map((t) => t.term);
    expect(insertedTerms).toContain("新詞彙");
    expect(insertedTerms).not.toContain("守護生命");
    expect(insertPendingTerm).toHaveBeenCalledTimes(1);
    expect(insertPendingTerm).toHaveBeenCalledWith(
      expect.objectContaining({ term: "新詞彙", videoTitle: "test" })
    );
  });

  it("dedupes repeated pending terms and adds a warning if the Drust insert fails", async () => {
    const insertPendingTerm = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await finishTranslation({
      videoTitle: "test",
      zhCues,
      translated: [cue(1, "text"), cue(2, "text2")],
      warnings: [],
      pendingRaw: [
        ["新詞彙", "New term"],
        ["新詞彙", "New term again"],
      ],
      glossary: [],
      insertPendingTerm,
    });

    expect(insertPendingTerm).toHaveBeenCalledTimes(1);
    expect(result.pending_terms).toEqual([]);
    expect(result.warnings.some((w) => w.includes("新詞彙"))).toBe(true);
  });

  it("builds the output filename by stripping the [中文字幕] prefix", async () => {
    const result = await finishTranslation({
      videoTitle: "[中文字幕]某影片",
      zhCues: [],
      translated: [],
      warnings: [],
      pendingRaw: [],
      glossary: [],
      insertPendingTerm: vi.fn(),
    });
    expect(result.filename).toBe("[英文字幕]某影片.srt");
    expect(result.srt).toBe(serializeSrt([]));
  });
});
