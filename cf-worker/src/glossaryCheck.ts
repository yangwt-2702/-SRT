import { Cue } from "./srt";
import { GlossaryRow } from "./promptBuilder";

// A single CJK character (e.g. 法/道/慈/苦/捨) recombines into countless
// unrelated compound words, so substring matching on it is unreliable —
// e.g. "慈" matches inside "慈濟" even when 慈濟 is itself a separately
// locked, correctly-translated term. Skip length-1 terms in this automated
// check (they still guide the translation via promptBuilder).
const MIN_CHECKABLE_TERM_LENGTH = 2;

function isContextDependent(row: GlossaryRow): boolean {
  const note = row.note;
  return typeof note === "string" && /context-dependent/i.test(note);
}

// Some glossary rows store a human-readable gloss with alternatives
// ("Medicine / Healthcare", "provide emotional comfort; feel at ease")
// rather than one literal enforced phrase — satisfied if any alternative appears.
function englishAlternatives(english: string): string[] {
  return english
    .split(/[/;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "and", "or", "with", "for", "be", "being", "been", "is", "are",
]);

// Natural translation legitimately varies in ways a literal-phrase match can't
// tolerate: plural vs singular ("Brothers" vs "Brother X"), noun vs adjective
// ("Gratitude" vs "grateful"), articles ("the Abode" vs "Jing Si Abode" / "that
// Abode"). Comparing on the significant words' first few letters absorbs most
// of that inflection without needing a real stemmer.
function significantWords(phrase: string): string[] {
  const cleaned = phrase.replace(/\([^)]*\)/g, " ").toLowerCase();
  return cleaned.split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function wordStem(word: string): string {
  return word.length <= 4 ? word : word.slice(0, 4);
}

function hasWord(translationWords: Set<string>, word: string): boolean {
  const stem = wordStem(word);
  for (const w of translationWords) {
    if (wordStem(w) === stem) return true;
  }
  return false;
}

// null = nothing checkable in this alternative (e.g. it was only stopwords),
// so it shouldn't count either way.
function alternativeSatisfied(alt: string, translationWords: Set<string>): boolean | null {
  const words = significantWords(alt);
  if (words.length === 0) return null;
  return words.every((w) => hasWord(translationWords, w));
}

export function checkConsistency(zhCues: Cue[], enCues: Cue[], glossary: GlossaryRow[]): string[] {
  const lockedTerms = glossary.filter(
    (row) =>
      row.locked &&
      row.chinese &&
      row.chinese.length >= MIN_CHECKABLE_TERM_LENGTH &&
      !isContextDependent(row)
  );
  const enByIndex = new Map(enCues.map((cue) => [cue.index, cue]));
  const warnings: string[] = [];

  for (const zhCue of zhCues) {
    const enCue = enByIndex.get(zhCue.index);
    if (!enCue) continue;
    if (enCue.text === "[翻譯失敗-請人工確認]") continue;

    const translationWords = new Set(enCue.text.toLowerCase().split(/[^a-z]+/).filter(Boolean));

    for (const row of lockedTerms) {
      const chinese = row.chinese as string;
      const alternatives = englishAlternatives(row.english ?? "");
      if (alternatives.length === 0) continue;
      if (!zhCue.text.includes(chinese)) continue;

      const results = alternatives.map((alt) => alternativeSatisfied(alt, translationWords));
      const checkable = results.filter((r): r is boolean => r !== null);
      if (checkable.length === 0) continue;

      if (!checkable.some((r) => r)) {
        warnings.push(
          `第 ${zhCue.index} 條：原文含鎖定詞「${chinese}」，` +
            `但譯文未包含鎖定譯法「${row.english}」，請人工確認 —— 譯文：${enCue.text}`
        );
      }
    }
  }
  return warnings;
}
