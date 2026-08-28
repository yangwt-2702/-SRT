import { Cue } from "./srt";

export interface GlossaryRow {
  chinese?: string;
  english?: string;
  locked?: number | boolean;
  [key: string]: unknown;
}

export function buildBatchPrompt(batch: Cue[], glossary: GlossaryRow[], contextTail: Array<[string, string]>): string {
  const relevant = glossary.filter(
    (row) => row.chinese && batch.some((cue) => cue.text.includes(row.chinese as string))
  );
  const glossaryLines = relevant.map((row) => `- ${row.chinese} -> ${row.english ?? ""}`).join("\n");
  const contextLines = contextTail.map(([zh, en]) => `（前情）${zh} -> ${en}`).join("\n");
  const cueLines = batch.map((cue) => `${cue.index}|||${cue.text.replace(/\n/g, " ")}`).join("\n");

  return `你是慈濟法師開示字幕的中翻英譯者。規則：
- 逐行 1:1 對應，輸出的行數、序號必須與輸入完全相同。即使原文有重複或相似的句子（例如同一句話講了兩三次），也絕對不可合併、拆分、省略或調換順序，每一行都要分別翻譯，一行都不能少。
- 海外志工姓名一律用漢語拼音，不用威妥瑪拼音。
- 經典/書名意譯，不要音譯。
- 不確定的詞彙翻譯，把該詞彙包成 [[UNSURE:中文詞|你採用的英文譯法]] 內嵌在譯文中，其餘照常翻譯，不要整行留白。

已鎖定詞彙庫（必須採用以下譯法）：
${glossaryLines || "（本批次無相關詞彙庫條目）"}

${contextLines ? "語境（前一批結尾）：\n" + contextLines : ""}

請翻譯以下字幕，輸出格式為每行「序號|||原文（逐字照抄，不可更動、不可省略）|||英文譯文」，不要加任何其他文字或說明。中間的原文欄位必須和輸入的該行文字一模一樣，用來核對翻譯是否對應到正確的行：
${cueLines}
`;
}

export function buildRetryPrompt(originalPrompt: string, errorDetail: string): string {
  return (
    `${originalPrompt}\n\n` +
    `上一次回覆格式不符規定，錯誤原因：${errorDetail}\n` +
    `請重新輸出，務必每行格式為「序號|||英文譯文」，序號需與輸入完全一致，不要有多餘文字。`
  );
}
