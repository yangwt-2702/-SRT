import { describe, it, expect } from "vitest";
import { parseLlmResponse, TranslationParseError } from "../src/responseParser";

describe("parseLlmResponse", () => {
  it("parses the happy path", () => {
    const raw = "1|||Dharma Master gave a talk\n2|||on compassion";
    const parsed = parseLlmResponse(raw, [1, 2]);
    expect(parsed).toEqual([
      { index: 1, text: "Dharma Master gave a talk", unsure: [] },
      { index: 2, text: "on compassion", unsure: [] },
    ]);
  });

  it("extracts UNSURE markers", () => {
    const raw = "1|||[[UNSURE:某道場|Some Place]] held an event";
    const parsed = parseLlmResponse(raw, [1]);
    expect(parsed[0].text).toBe("Some Place held an event");
    expect(parsed[0].unsure).toEqual([["某道場", "Some Place"]]);
  });

  it("raises on a malformed UNSURE marker missing the pipe", () => {
    const raw = "1|||[[UNSURE:某道場]] held an event";
    expect(() => parseLlmResponse(raw, [1])).toThrow(TranslationParseError);
  });

  it("raises on index mismatch", () => {
    const raw = "1|||text one\n3|||text three";
    expect(() => parseLlmResponse(raw, [1, 2])).toThrow(TranslationParseError);
  });

  it("raises on a malformed line missing the ||| delimiter", () => {
    const raw = "1: text without delimiter";
    expect(() => parseLlmResponse(raw, [1])).toThrow(TranslationParseError);
  });
});
