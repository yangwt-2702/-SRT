import { describe, it, expect } from "vitest";
import { checkConsistency } from "../src/glossaryCheck";
import { Cue } from "../src/srt";
import { GlossaryRow } from "../src/promptBuilder";

const GLOSSARY: GlossaryRow[] = [
  { chinese: "上人", english: "Dharma Master", locked: 1 },
  { chinese: "靜思精舍", english: "Jing Si Abode", locked: 1 },
  { chinese: "隨喜", english: "rejoice", locked: 0 },
];

function cue(index: number, text: string): Cue {
  return { index, start: "00:00:00,000", end: "00:00:01,000", text };
}

describe("checkConsistency", () => {
  it("flags a missing locked term", () => {
    const warnings = checkConsistency([cue(1, "上人開示")], [cue(1, "The teacher gave a talk")], GLOSSARY);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("上人");
    expect(warnings[0]).toContain("Dharma Master");
  });

  it("has no warning when the term is present", () => {
    const warnings = checkConsistency([cue(1, "上人開示")], [cue(1, "Dharma Master gave a talk")], GLOSSARY);
    expect(warnings).toEqual([]);
  });

  it("never flags unlocked terms", () => {
    const warnings = checkConsistency([cue(1, "隨喜功德")], [cue(1, "meritorious deed")], GLOSSARY);
    expect(warnings).toEqual([]);
  });

  it("has no warning for a failed-batch placeholder cue", () => {
    const warnings = checkConsistency([cue(1, "上人開示")], [cue(1, "[翻譯失敗-請人工確認]")], GLOSSARY);
    expect(warnings).toEqual([]);
  });

  it("produces no warnings for an empty glossary chinese value", () => {
    const glossary: GlossaryRow[] = [{ chinese: "", english: "x", locked: 1 }];
    const warnings = checkConsistency([cue(1, "任何內容都可以")], [cue(1, "any content at all")], glossary);
    expect(warnings).toEqual([]);
  });
});
