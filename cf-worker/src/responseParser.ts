export class TranslationParseError extends Error {}

export interface ParsedLine {
  index: number;
  text: string;
  unsure: Array<[string, string]>;
}

export interface ExpectedCue {
  index: number;
  text: string;
}

const UNSURE_RE = /\[\[UNSURE:(.*?)\|(.*?)\]\]/g;
// The model sometimes hedges on an uncertain term with a MediaWiki-style
// [[left|right]] link marker instead of the prescribed [[UNSURE:zh|en]] one.
const WIKILINK_RE = /\[\[([^|[\]]+)\|([^|[\]]+)\]\]/g;
// ...or drops the brackets entirely and glosses inline: "消舊業 (eliminate past karma)".
const INLINE_GLOSS_RE = /([一-鿿]+)\s*\(([^()]*)\)/g;
const CJK_RE = /[一-鿿]/;

// Ignore whitespace-only differences when checking the model's echoed source
// line against the real cue text -- it sometimes normalizes spacing -- but
// treat any other difference (missing/extra/substituted characters) as real,
// since that's exactly the signature of a batch silently dropping or
// reshuffling a line while still emitting a clean, sequential-looking index
// list (see the 2026-08-28 line-shift bug this guards against).
function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, "");
}

export function parseLlmResponse(raw: string, expected: ExpectedCue[]): ParsedLine[] {
  const lines = raw.trim().split("\n").filter((line) => line.trim().length > 0);
  const parsed: Array<ParsedLine & { zhEcho: string }> = [];

  for (const line of lines) {
    const sepIndex = line.indexOf("|||");
    if (sepIndex === -1) {
      throw new TranslationParseError(`格式不符，缺少分隔符號 |||：${JSON.stringify(line)}`);
    }
    const indexStr = line.slice(0, sepIndex);
    const rest = line.slice(sepIndex + 3);
    const index = parseInt(indexStr.trim(), 10);
    if (Number.isNaN(index)) {
      throw new TranslationParseError(`序號無法解析：${JSON.stringify(line)}`);
    }

    const sepIndex2 = rest.indexOf("|||");
    if (sepIndex2 === -1) {
      throw new TranslationParseError(
        `格式不符，缺少第二個分隔符號 |||（原文核對欄位）：${JSON.stringify(line)}`
      );
    }
    const zhEcho = rest.slice(0, sepIndex2);
    const text = rest.slice(sepIndex2 + 3);

    const unsureMatches: Array<[string, string]> = [];
    for (const m of text.matchAll(UNSURE_RE)) {
      unsureMatches.push([m[1], m[2]]);
    }
    let cleanText = text.replace(UNSURE_RE, (_m, _zh, en) => en);

    cleanText = cleanText.replace(WIKILINK_RE, (_m, left: string, right: string) => {
      if (CJK_RE.test(left) && left.trim() !== right.trim()) {
        unsureMatches.push([left.trim(), right.trim()]);
      }
      return right;
    });

    cleanText = cleanText.replace(INLINE_GLOSS_RE, (_m, zh: string, gloss: string) => {
      unsureMatches.push([zh, gloss.trim()]);
      // Padded with spaces since the model often glues the gloss directly
      // onto neighboring text with no space (e.g. "to消舊業 (...)"); collapsed below.
      return ` ${gloss.trim()} `;
    });

    cleanText = cleanText
      .replace(/[[\]]/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();

    if (cleanText.includes("[[")) {
      throw new TranslationParseError(`未正確格式化的標記殘留於譯文：${JSON.stringify(line)}`);
    }
    if (CJK_RE.test(cleanText)) {
      throw new TranslationParseError(
        `譯文仍含中文殘留，請完整譯為英文，不要保留中文字或使用 [[...]]/[...] 等符號：${JSON.stringify(line)}`
      );
    }
    parsed.push({ index, text: cleanText, unsure: unsureMatches, zhEcho });
  }

  const actualIndices = parsed.map((p) => p.index);
  const expectedIndices = expected.map((e) => e.index);
  const indicesMatch =
    actualIndices.length === expectedIndices.length &&
    actualIndices.every((v, i) => v === expectedIndices[i]);
  if (!indicesMatch) {
    throw new TranslationParseError(
      `序號不符，預期 ${JSON.stringify(expectedIndices)}，實際 ${JSON.stringify(actualIndices)}`
    );
  }

  // The index list alone can look perfectly sequential even when the model
  // has silently dropped or merged a source line -- it just keeps counting
  // and the total comes out right. Cross-checking the echoed source text
  // against the real cue is what actually proves line N's translation is
  // line N's translation, not line N-1's or N+1's shifted into place.
  for (let i = 0; i < parsed.length; i++) {
    const expectedText = normalizeForCompare(expected[i].text.replace(/\n/g, " "));
    const actualEcho = normalizeForCompare(parsed[i].zhEcho);
    if (actualEcho !== expectedText) {
      throw new TranslationParseError(
        `第 ${expected[i].index} 行的原文核對欄位與來源不符，可能是譯文對應錯位：預期原文 ${JSON.stringify(
          expected[i].text
        )}，實際回傳 ${JSON.stringify(parsed[i].zhEcho)}`
      );
    }
  }

  return parsed.map(({ index, text, unsure }) => ({ index, text, unsure }));
}
