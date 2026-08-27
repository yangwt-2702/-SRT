import { describe, it, expect } from "vitest";
import { buildBatchPrompt, buildRetryPrompt, GlossaryRow } from "../src/promptBuilder";
import { Cue } from "../src/srt";

const GLOSSARY: GlossaryRow[] = [{ chinese: "上人", english: "Dharma Master", locked: 1 }];

function cue(index: number, start: string, end: string, text: string): Cue {
  return { index, start, end, text };
}

describe("buildBatchPrompt", () => {
  it("includes rules, glossary, and cues", () => {
    const batch = [cue(1, "00:00:00,000", "00:00:01,000", "上人開示")];
    const prompt = buildBatchPrompt(batch, GLOSSARY, []);
    expect(prompt.includes("1:1") || prompt.includes("逐行")).toBe(true);
    expect(prompt).toContain("上人");
    expect(prompt).toContain("Dharma Master");
    expect(prompt).toContain("1|||上人開示");
  });

  it("flattens multiline cue text and prefixes every cue line", () => {
    const batch = [cue(1, "00:00:00,000", "00:00:01,000", "上人開示\n慈悲喜捨")];
    const prompt = buildBatchPrompt(batch, GLOSSARY, []);
    const marker = "請翻譯以下字幕，輸出格式為每行「序號|||英文譯文」，不要加任何其他文字或說明：";
    const cueSection = prompt.split(marker)[1];
    expect(cueSection).toContain("慈悲喜捨");
    for (const rawLine of cueSection.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      expect(/^\d+\|\|\|/.test(line)).toBe(true);
    }
  });
});

describe("buildRetryPrompt", () => {
  it("appends the error detail to the original prompt", () => {
    const prompt = buildRetryPrompt("original prompt text", "missing index 3");
    expect(prompt).toContain("original prompt text");
    expect(prompt).toContain("missing index 3");
  });
});
