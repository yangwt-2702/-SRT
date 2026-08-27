export class TranslationParseError extends Error {}

export interface ParsedLine {
  index: number;
  text: string;
  unsure: Array<[string, string]>;
}

const UNSURE_RE = /\[\[UNSURE:(.*?)\|(.*?)\]\]/g;

export function parseLlmResponse(raw: string, expectedIndices: number[]): ParsedLine[] {
  const lines = raw.trim().split("\n").filter((line) => line.trim().length > 0);
  const parsed: ParsedLine[] = [];

  for (const line of lines) {
    const sepIndex = line.indexOf("|||");
    if (sepIndex === -1) {
      throw new TranslationParseError(`格式不符，缺少分隔符號 |||：${JSON.stringify(line)}`);
    }
    const indexStr = line.slice(0, sepIndex);
    const text = line.slice(sepIndex + 3);
    const index = parseInt(indexStr.trim(), 10);
    if (Number.isNaN(index)) {
      throw new TranslationParseError(`序號無法解析：${JSON.stringify(line)}`);
    }

    const unsureMatches: Array<[string, string]> = [];
    for (const m of text.matchAll(UNSURE_RE)) {
      unsureMatches.push([m[1], m[2]]);
    }
    const cleanText = text.replace(UNSURE_RE, (_m, _zh, en) => en).trim();
    if (cleanText.includes("[[UNSURE")) {
      throw new TranslationParseError(`未正確格式化的 UNSURE 標記殘留於譯文：${JSON.stringify(line)}`);
    }
    parsed.push({ index, text: cleanText, unsure: unsureMatches });
  }

  const actualIndices = parsed.map((p) => p.index);
  const matches =
    actualIndices.length === expectedIndices.length &&
    actualIndices.every((v, i) => v === expectedIndices[i]);
  if (!matches) {
    throw new TranslationParseError(
      `序號不符，預期 ${JSON.stringify(expectedIndices)}，實際 ${JSON.stringify(actualIndices)}`
    );
  }
  return parsed;
}
