import { describe, it, expect, vi } from "vitest";
import { runOneBatch, finishTranslation, FAILURE_TEXT } from "../src/orchestrator";
import { Cue, serializeSrt } from "../src/srt";
import { GlossaryRow } from "../src/promptBuilder";

const GLOSSARY: GlossaryRow[] = [{ chinese: "志工", english: "volunteer", locked: 1 }];

function cue(index: number, text: string): Cue {
  return { index, start: "00:00:00,000", end: "00:00:01,000", text };
}

describe("runOneBatch", () => {
  it("succeeds on the first attempt", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockResolvedValue("1|||English 1\n2|||English 2");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1", "English 2"]);
    expect(outcome.warning).toBeNull();
    expect(outcome.pendingRaw).toEqual([]);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });

  it("retries once then succeeds", async () => {
    const batch = [cue(1, "志工開示")];
    const callLlm = vi.fn().mockResolvedValueOnce("only one line, wrong format").mockResolvedValueOnce("1|||English 1");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1"]);
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it("marks the whole batch failed after exhausting retries", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockResolvedValue("garbled non-conforming output");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });

    expect(outcome.translated.every((c) => c.text === FAILURE_TEXT)).toBe(true);
    expect(outcome.warning).not.toBeNull();
    expect(outcome.newContextTail).toEqual([]);
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it("collects UNSURE markers into pendingRaw and the last 3 pairs into newContextTail", async () => {
    const batch = [cue(1, "甲"), cue(2, "乙"), cue(3, "丙"), cue(4, "丁")];
    const callLlm = vi
      .fn()
      .mockResolvedValue(
        "1|||[[UNSURE:甲詞|Jia term]] one\n2|||two\n3|||three\n4|||four"
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
