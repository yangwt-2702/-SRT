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

  it("matches case-insensitively", () => {
    const glossary: GlossaryRow[] = [{ chinese: "志工", english: "Volunteer", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "志工早會")],
      [cue(1, "the volunteer morning assembly")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("is satisfied by any one of several slash/semicolon-separated alternatives", () => {
    const glossary: GlossaryRow[] = [
      { chinese: "醫療", english: "Medicine / Healthcare", locked: 1 },
      { chinese: "安心", english: "provide emotional comfort; feel at ease", locked: 1 },
    ];
    const warnings = checkConsistency(
      [cue(1, "醫療志業"), cue(2, "讓長輩安心")],
      [cue(1, "the healthcare mission"), cue(2, "so the elder could feel at ease")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("never flags a single-CJK-character locked term", () => {
    const glossary: GlossaryRow[] = [{ chinese: "慈", english: "loving-kindness", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "慈濟醫院")],
      [cue(1, "Tzu Chi Hospital")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("never flags a term whose note marks it context-dependent", () => {
    const glossary: GlossaryRow[] = [
      { chinese: "教授", english: "the Instructing Master", locked: 1, note: "context-dependent — ordination only" },
    ];
    const warnings = checkConsistency(
      [cue(1, "他是教授")],
      [cue(1, "he is a professor")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("tolerates singular/plural variation (Brothers vs a named Brother)", () => {
    const glossary: GlossaryRow[] = [{ chinese: "師兄", english: "Brothers", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "師兄王凌義說")],
      [cue(1, "Just now, Brother Wang Ling-yi said")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("tolerates noun/adjective variation (Gratitude vs grateful)", () => {
    const glossary: GlossaryRow[] = [{ chinese: "感恩", english: "Gratitude", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "要感恩")],
      [cue(1, "be grateful for everything")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("tolerates a dropped article and inserted modifier (the Abode vs Jing Si Abode / that Abode)", () => {
    const glossary: GlossaryRow[] = [{ chinese: "精舍", english: "the Abode", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "在精舍門口"), cue(2, "看著那精舍")],
      [cue(1, "in front of the Main Hall of Jing Si Abode"), cue(2, "Looking at that Abode")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("tolerates a verb-form change (to be certified vs have been certified)", () => {
    const glossary: GlossaryRow[] = [{ chinese: "受證", english: "to be certified / consecrated", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "你受證了嗎")],
      [cue(1, "Have you been certified?")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("tolerates a stripped parenthetical qualifier (to form good affinities (with others))", () => {
    const glossary: GlossaryRow[] = [{ chinese: "結好緣", english: "to form good affinities (with others)", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "這一生可以結好緣")],
      [cue(1, "In this life, you can form good affinities.")],
      glossary
    );
    expect(warnings).toEqual([]);
  });

  it("still flags a term that is genuinely missing from the translation", () => {
    const glossary: GlossaryRow[] = [{ chinese: "上人", english: "Dharma Master", locked: 1 }];
    const warnings = checkConsistency(
      [cue(1, "上人開示")],
      [cue(1, "he gave a talk about kindness")],
      glossary
    );
    expect(warnings.length).toBe(1);
  });
});
