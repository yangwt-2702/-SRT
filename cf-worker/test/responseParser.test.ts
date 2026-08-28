import { describe, it, expect } from "vitest";
import { parseLlmResponse, TranslationParseError } from "../src/responseParser";

describe("parseLlmResponse", () => {
  it("parses the happy path", () => {
    const raw = "1|||法師開示|||Dharma Master gave a talk\n2|||關於慈悲|||on compassion";
    const parsed = parseLlmResponse(raw, [
      { index: 1, text: "法師開示" },
      { index: 2, text: "關於慈悲" },
    ]);
    expect(parsed).toEqual([
      { index: 1, text: "Dharma Master gave a talk", unsure: [] },
      { index: 2, text: "on compassion", unsure: [] },
    ]);
  });

  it("extracts UNSURE markers", () => {
    const raw = "1|||某道場舉辦活動|||[[UNSURE:某道場|Some Place]] held an event";
    const parsed = parseLlmResponse(raw, [{ index: 1, text: "某道場舉辦活動" }]);
    expect(parsed[0].text).toBe("Some Place held an event");
    expect(parsed[0].unsure).toEqual([["某道場", "Some Place"]]);
  });

  it("raises on a malformed UNSURE marker missing the pipe", () => {
    const raw = "1|||某道場舉辦活動|||[[UNSURE:某道場]] held an event";
    expect(() => parseLlmResponse(raw, [{ index: 1, text: "某道場舉辦活動" }])).toThrow(TranslationParseError);
  });

  it("raises on index mismatch", () => {
    const raw = "1|||甲|||text one\n3|||丙|||text three";
    expect(() =>
      parseLlmResponse(raw, [
        { index: 1, text: "甲" },
        { index: 2, text: "乙" },
      ])
    ).toThrow(TranslationParseError);
  });

  it("raises on a malformed line missing the ||| delimiter", () => {
    const raw = "1: text without delimiter";
    expect(() => parseLlmResponse(raw, [{ index: 1, text: "甲" }])).toThrow(TranslationParseError);
  });

  it("raises on a line with only one ||| delimiter (missing the echo field)", () => {
    const raw = "1|||text without an echo field";
    expect(() => parseLlmResponse(raw, [{ index: 1, text: "甲" }])).toThrow(TranslationParseError);
  });

  it("cleans up a MediaWiki-style [[zh|en]] hedge and records it as a pending term", () => {
    const raw = "1|||慈濟是佛教|||Tzu Chi is [[佛教|Buddhism]].";
    const parsed = parseLlmResponse(raw, [{ index: 1, text: "慈濟是佛教" }]);
    expect(parsed[0].text).toBe("Tzu Chi is Buddhism.");
    expect(parsed[0].unsure).toEqual([["佛教", "Buddhism"]]);
  });

  it("cleans up a self-referential [[en|en]] hedge without flagging it as a pending term", () => {
    const raw = "1|||將成為菩提林|||It will become a [[Bodhi (Enlightenment)|Bodhi (Enlightenment)]] forest";
    const parsed = parseLlmResponse(raw, [{ index: 1, text: "將成為菩提林" }]);
    expect(parsed[0].text).toBe("It will become a Bodhi (Enlightenment) forest");
    expect(parsed[0].unsure).toEqual([]);
  });

  it("cleans up an inline 'zh (gloss)' hedge and records it as a pending term", () => {
    const raw = "1|||隨緣消舊業|||Follow affinities to消舊業 (eliminate past karma),";
    const parsed = parseLlmResponse(raw, [{ index: 1, text: "隨緣消舊業" }]);
    expect(parsed[0].text).toBe("Follow affinities to eliminate past karma,");
    expect(parsed[0].unsure).toEqual([["消舊業", "eliminate past karma"]]);
  });

  it("strips stray unpaired square brackets", () => {
    const raw = "1|||因為愛而做|||I am [doing it] because of love";
    const parsed = parseLlmResponse(raw, [{ index: 1, text: "因為愛而做" }]);
    expect(parsed[0].text).toBe("I am doing it because of love");
  });

  it("raises when Chinese text remains with no recognizable gloss pattern to clean", () => {
    const raw = "1|||殘留文字|||some text 殘留文字 with no gloss";
    expect(() => parseLlmResponse(raw, [{ index: 1, text: "殘留文字" }])).toThrow(TranslationParseError);
  });

  it("ignores whitespace-only differences in the echoed source line", () => {
    const raw = "1|||一年  兩個月|||one year and two months";
    const parsed = parseLlmResponse(raw, [{ index: 1, text: "一年兩個月" }]);
    expect(parsed[0].text).toBe("one year and two months");
  });

  it("compares the echo against the flattened (newline-joined) source text", () => {
    const raw = "1|||上人開示 慈悲喜捨|||Master's teaching on compassion";
    const parsed = parseLlmResponse(raw, [{ index: 1, text: "上人開示\n慈悲喜捨" }]);
    expect(parsed[0].text).toBe("Master's teaching on compassion");
  });

  // Regression test for a real production bug (2026-08-28): a batch with a
  // short phrase repeated across consecutive cues ("一年2個月" said three
  // times for emphasis) made the model silently reuse/shift translations by
  // one line while still emitting a clean sequential index list (1,2,3...),
  // which the index-only check couldn't catch. The echoed source line is
  // what exposes it.
  it("raises when a line's translation has silently shifted onto the wrong source line", () => {
    const raw = ["1|||一年2個月|||was that school built", "2|||蓋那個學校|||in just one year and two months"].join(
      "\n"
    );
    expect(() =>
      parseLlmResponse(raw, [
        { index: 1, text: "一年2個月" },
        { index: 2, text: "蓋那個學校" },
      ])
    ).not.toThrow();
    // Same two lines, but shifted by one relative to the real source order:
    const shiftedRaw = ["1|||蓋那個學校|||was that school built", "2|||一年2個月|||in just one year and two months"].join(
      "\n"
    );
    expect(() =>
      parseLlmResponse(shiftedRaw, [
        { index: 1, text: "一年2個月" },
        { index: 2, text: "蓋那個學校" },
      ])
    ).toThrow(TranslationParseError);
  });
});
