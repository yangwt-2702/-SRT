import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSrt, serializeSrt, splitBatches, validateIndices, validateUpload, Cue } from "../src/srt";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample_zh.srt");

function cue(index: number, start: string, end: string, text: string): Cue {
  return { index, start, end, text };
}

describe("parseSrt", () => {
  it("returns expected cues", () => {
    const content = readFileSync(FIXTURE, "utf-8");
    const cues = parseSrt(content);
    expect(cues.length).toBe(12);
    expect(cues[0]).toEqual(cue(1, "00:00:00,000", "00:00:01,433", "我當時分享的"));
    expect(cues[cues.length - 1].index).toBe(12);
    expect(cues[cues.length - 1].text).toBe("雖然是由我們的常住師父來主持");
  });
});

describe("serializeSrt", () => {
  it("round-trips through parseSrt", () => {
    const content = readFileSync(FIXTURE, "utf-8");
    const cues = parseSrt(content);
    const rebuilt = parseSrt(serializeSrt(cues));
    expect(rebuilt).toEqual(cues);
  });
});

describe("splitBatches", () => {
  it("respects batch size", () => {
    const cues = Array.from({ length: 12 }, (_, i) => cue(i + 1, "00:00:00,000", "00:00:01,000", `t${i + 1}`));
    const batches = splitBatches(cues, 5);
    expect(batches.map((b) => b.length)).toEqual([5, 5, 2]);
    expect(batches[0][0].index).toBe(1);
    expect(batches[batches.length - 1][batches[batches.length - 1].length - 1].index).toBe(12);
  });
});

describe("validateIndices", () => {
  it("is true for an exact match", () => {
    const cues = [1, 2, 3].map((i) => cue(i, "", "", ""));
    expect(validateIndices(cues, [1, 2, 3])).toBe(true);
  });

  it("is false for missing or reordered indices", () => {
    const cues = [1, 2, 3].map((i) => cue(i, "", "", ""));
    expect(validateIndices(cues, [1, 3])).toBe(false);
    expect(validateIndices(cues, [1, 3, 2])).toBe(false);
  });
});

describe("validateUpload", () => {
  it("rejects a non-.srt filename", () => {
    const result = validateUpload("notes.txt", "not an srt");
    expect(result).toEqual({ error: "請上傳 .srt 檔案" });
  });

  it("rejects content with no parseable cues", () => {
    const result = validateUpload("sample.srt", "not srt content at all");
    expect(result).toEqual({ error: "無法解析 SRT 內容，請確認檔案格式" });
  });

  it("rejects an srt missing a blank line between cues (cues get swallowed)", () => {
    // Missing blank line between cue 1 and cue 2 causes parseSrt to swallow
    // cue 2 into cue 1's text (see the CUE_RE lookahead in src/srt.ts).
    const malformed =
      "1\n00:00:00,000 --> 00:00:01,000\nHello\n" +
      "2\n00:00:01,000 --> 00:00:02,000\nWorld\n";
    const result = validateUpload("sample.srt", malformed);
    expect(result).toEqual({
      error: "無法解析 SRT 內容，部分字幕可能因格式問題被跳過，請檢查檔案格式",
    });
  });

  it("accepts well-formed content and returns parsed cues", () => {
    const content = readFileSync(FIXTURE, "utf-8");
    const result = validateUpload("sample_zh.srt", content);
    expect("cues" in result).toBe(true);
    if ("cues" in result) {
      expect(result.cues.length).toBe(12);
    }
  });
});
