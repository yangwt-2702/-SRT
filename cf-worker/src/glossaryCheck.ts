import { Cue } from "./srt";
import { GlossaryRow } from "./promptBuilder";

export function checkConsistency(zhCues: Cue[], enCues: Cue[], glossary: GlossaryRow[]): string[] {
  const lockedTerms = glossary.filter((row) => row.locked);
  const enByIndex = new Map(enCues.map((cue) => [cue.index, cue]));
  const warnings: string[] = [];

  for (const zhCue of zhCues) {
    const enCue = enByIndex.get(zhCue.index);
    if (!enCue) continue;
    if (enCue.text === "[翻譯失敗-請人工確認]") continue;

    for (const row of lockedTerms) {
      const chinese = row.chinese;
      const english = row.english ?? "";
      if (!chinese) continue;
      if (zhCue.text.includes(chinese) && !enCue.text.includes(english)) {
        warnings.push(
          `第 ${zhCue.index} 條：原文含鎖定詞「${chinese}」，` +
            `但譯文未包含鎖定譯法「${english}」，請人工確認 —— 譯文：${enCue.text}`
        );
      }
    }
  }
  return warnings;
}
