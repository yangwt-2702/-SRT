# Cloudflare 多人版 SRT 翻譯工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the existing, tested Python Flask SRT-translation webtool into a serverless Cloudflare Pages + Pages Functions + Durable Object app, so colleagues can use it via a shared URL without any machine needing to stay on.

**Architecture:** Static frontend on Cloudflare Pages (`cf-worker/frontend/`) calls a Pages Functions API (`cf-worker/functions/api/jobs/*`) that creates a per-job Durable Object. The Durable Object uses its `alarm()` to process one ~50-cue batch at a time against the LLM proxy, persisting progress to its own storage; the frontend polls `GET /api/jobs/:id` until `status: "done"`. All business logic (SRT parsing, prompt building, response parsing, glossary consistency checking, Drust REST calls, batch/retry orchestration) is ported 1:1 from the tested Python modules into plain, dependency-injected TypeScript functions in `cf-worker/src/`, unit-tested with plain Vitest — the same test boundary the Python suite already uses (mock `call_llm`/`DrustClient`, not the HTTP layer). The Durable Object class and the two Pages Functions routes are intentionally thin adapters with no unit tests of their own (see Global Constraints) — their correctness is verified by a real `wrangler pages dev` smoke test in the final task, because faithfully simulating Durable Object alarms + Pages Functions bindings in a unit test harness is high-risk/low-value compared to just running the real thing once locally.

**Tech Stack:** TypeScript, Cloudflare Pages Functions, Cloudflare Durable Objects, Vitest, Wrangler CLI.

**Spec:** `docs/superpowers/specs/2026-08-27-cloudflare-srt-webtool-design.md`

## Global Constraints

- New code lives entirely under `cf-worker/` (new folder). The existing `webtool/` Python app is NOT modified or deleted.
- `BATCH_SIZE = 50` cues per batch, `MAX_RETRIES = 3` attempts per batch (exact same values as `webtool/config.py`).
- LLM proxy: `LLM_PROXY_BASE_URL = "https://sberecognition.tzuchi-org.tw/functions/v1/llm-proxy/v1"`, `LLM_PROXY_MODEL = "Qwen3.6-35B-A3B"` (deliberately different from the Python app's `gpt-oss-120b` — this was the user's explicit choice for this rewrite), timeout 180 seconds (180000 ms).
- Drust: `DRUST_BASE = "https://tcdrust.tzuchi-org.tw"`, `DRUST_TENANT_ID = "9eec6c81-f435-4811-b86d-a4829edbecea"`. Read `translation_glossary` with the anon token; write `pending_terms` with the service token. Both tokens come from Cloudflare secrets (`wrangler pages secret put`), never hardcoded — see the credential-leak history in `docs/superpowers/plans/2026-08-25-srt-translation-webtool.md`'s Global Constraints for why this matters.
- Failure-placeholder text for a batch that exhausts retries: exactly `[翻譯失敗-請人工確認]` (must match this literal string — `glossaryCheck`/consistency logic skips cues with this exact text).
- Durable Objects support exactly **one** pending alarm per object at a time. This means: while a job is `"processing"`, every alarm fire either re-arms an immediate alarm (more batches) or, on the last batch, transitions to a terminal state; the 24h cleanup alarm is only armed *after* the job reaches `"done"` or `"error"` — never at job creation, or it would be immediately overwritten by the first batch-processing alarm.
- Testing: plain Vitest (no Workers runtime simulation) for everything in `src/`, mocking `fetch` at the module boundary — mirrors the existing Python tests' own mocking boundary (`@patch("webtool.server.call_llm")`, `responses.activate` for HTTP). The Durable Object class (`jobDurableObject.ts`) and the two Pages Functions route files are thin glue with no dedicated unit tests; verify them via `tsc --noEmit` per-task and one real `wrangler pages dev` smoke test in the final task.
- All Chinese-language strings (error messages, prompt template, UI text) must be copied character-for-character from the Python originals — these are user-facing and already reviewed/approved wording, not to be reworded during the port.

---

### Task 1: Project scaffolding

**Files:**
- Create: `cf-worker/package.json`
- Create: `cf-worker/tsconfig.json`
- Create: `cf-worker/vitest.config.ts`
- Create: `cf-worker/.gitignore`
- Create: `cf-worker/src/.gitkeep`
- Create: `cf-worker/test/.gitkeep`

**Interfaces:**
- Produces: an `npm test` script (via `vitest run`) and `npm run typecheck` script (via `tsc --noEmit`) that every later task uses to verify its work.

- [ ] **Step 1: Create the directory and config files**

`cf-worker/package.json`:
```json
{
  "name": "cf-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler pages dev frontend",
    "deploy": "wrangler pages deploy frontend"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5",
    "wrangler": "^3.78.0"
  }
}
```

`cf-worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "functions/**/*.ts", "test/**/*.ts"]
}
```

`cf-worker/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

`cf-worker/.gitignore`:
```
node_modules/
.wrangler/
.dev.vars
dist/
```

- [ ] **Step 2: Install dependencies**

Run (from `cf-worker/`): `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Verify the test and typecheck scripts run with zero files**

Run: `npm test`
Expected: Vitest reports "No test files found" (not an error — there are no test files yet) or passes with 0 tests, exits 0.

Run: `npm run typecheck`
Expected: exits 0 (no `.ts` files yet to fail on).

- [ ] **Step 4: Commit**

```bash
git add cf-worker/package.json cf-worker/package-lock.json cf-worker/tsconfig.json cf-worker/vitest.config.ts cf-worker/.gitignore cf-worker/src/.gitkeep cf-worker/test/.gitkeep
git commit -m "chore: scaffold cf-worker TypeScript project"
```

---

### Task 2: SRT parsing, batching, and upload validation (`src/srt.ts`)

**Files:**
- Create: `cf-worker/src/srt.ts`
- Test: `cf-worker/test/srt.test.ts`
- Create: `cf-worker/test/fixtures/sample_zh.srt` (copy of `tests/fixtures/sample_zh.srt`)

**Interfaces:**
- Produces (used by every later task): `Cue` interface `{ index: number; start: string; end: string; text: string }`; `parseSrt(content: string): Cue[]`; `serializeSrt(cues: Cue[]): string`; `splitBatches(cues: Cue[], batchSize: number): Cue[][]`; `validateIndices(sourceBatch: Cue[], returnedIndices: number[]): boolean`; `validateUpload(filename: string, content: string): { cues: Cue[] } | { error: string }`.

- [ ] **Step 1: Copy the fixture file**

```bash
mkdir -p cf-worker/test/fixtures
cp tests/fixtures/sample_zh.srt cf-worker/test/fixtures/sample_zh.srt
```

- [ ] **Step 2: Write the failing tests**

`cf-worker/test/srt.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSrt, serializeSrt, splitBatches, validateIndices, validateUpload, Cue } from "../src/srt";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample_zh.srt");

function cue(index: number, start: string, end: string, text: string): Cue {
  return { index, start, end, text };
}

describe("parseSrt", () => {
  it("returns expected cues", () => {
    const content = readFileSync(FIXTURE, "utf-8");
    const cues = parseSrt(content);
    expect(cues.length).toBe(12);
    expect(cues[0]).toEqual(cue(1, "00:00:00,000", "00:00:01,433", "我當時分享的"));
    expect(cues[cues.length - 1].index).toBe(12);
    expect(cues[cues.length - 1].text).toBe("雖然是由我們的常住師父來主持");
  });
});

describe("serializeSrt", () => {
  it("round-trips through parseSrt", () => {
    const content = readFileSync(FIXTURE, "utf-8");
    const cues = parseSrt(content);
    const rebuilt = parseSrt(serializeSrt(cues));
    expect(rebuilt).toEqual(cues);
  });
});

describe("splitBatches", () => {
  it("respects batch size", () => {
    const cues = Array.from({ length: 12 }, (_, i) => cue(i + 1, "00:00:00,000", "00:00:01,000", `t${i + 1}`));
    const batches = splitBatches(cues, 5);
    expect(batches.map((b) => b.length)).toEqual([5, 5, 2]);
    expect(batches[0][0].index).toBe(1);
    expect(batches[batches.length - 1][batches[batches.length - 1].length - 1].index).toBe(12);
  });
});

describe("validateIndices", () => {
  it("is true for an exact match", () => {
    const cues = [1, 2, 3].map((i) => cue(i, "", "", ""));
    expect(validateIndices(cues, [1, 2, 3])).toBe(true);
  });

  it("is false for missing or reordered indices", () => {
    const cues = [1, 2, 3].map((i) => cue(i, "", "", ""));
    expect(validateIndices(cues, [1, 3])).toBe(false);
    expect(validateIndices(cues, [1, 3, 2])).toBe(false);
  });
});

describe("validateUpload", () => {
  it("rejects a non-.srt filename", () => {
    const result = validateUpload("notes.txt", "not an srt");
    expect(result).toEqual({ error: "請上傳 .srt 檔案" });
  });

  it("rejects content with no parseable cues", () => {
    const result = validateUpload("sample.srt", "not srt content at all");
    expect(result).toEqual({ error: "無法解析 SRT 內容，請確認檔案格式" });
  });

  it("rejects an srt missing a blank line between cues (cues get swallowed)", () => {
    // Missing blank line between cue 1 and cue 2 causes parseSrt to swallow
    // cue 2 into cue 1's text (see the CUE_RE lookahead in src/srt.ts).
    const malformed =
      "1\n00:00:00,000 --> 00:00:01,000\nHello\n" +
      "2\n00:00:01,000 --> 00:00:02,000\nWorld\n";
    const result = validateUpload("sample.srt", malformed);
    expect(result).toEqual({
      error: "無法解析 SRT 內容，部分字幕可能因格式問題被跳過，請檢查檔案格式",
    });
  });

  it("accepts well-formed content and returns parsed cues", () => {
    const content = readFileSync(FIXTURE, "utf-8");
    const result = validateUpload("sample_zh.srt", content);
    expect("cues" in result).toBe(true);
    if ("cues" in result) {
      expect(result.cues.length).toBe(12);
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test` (from `cf-worker/`)
Expected: FAIL — `src/srt.ts` does not exist yet.

- [ ] **Step 4: Implement `src/srt.ts`**

```ts
export interface Cue {
  index: number;
  start: string;
  end: string;
  text: string;
}

const CUE_RE = /(\d+)\s*\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\s*\n(.*?)(?=\n\s*\n\d+\s*\n|$)/gs;

export function parseSrt(content: string): Cue[] {
  const normalized = content.replace(/﻿/g, "").replace(/\r\n/g, "\n").trim() + "\n";
  const cues: Cue[] = [];
  const re = new RegExp(CUE_RE.source, CUE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const [, index, start, end, text] = match;
    cues.push({ index: parseInt(index, 10), start, end, text: text.trim() });
  }
  return cues;
}

export function serializeSrt(cues: Cue[]): string {
  const blocks = cues.map((cue) => `${cue.index}\n${cue.start} --> ${cue.end}\n${cue.text}\n`);
  return blocks.join("\n") + "\n";
}

export function splitBatches(cues: Cue[], batchSize: number): Cue[][] {
  const batches: Cue[][] = [];
  for (let i = 0; i < cues.length; i += batchSize) {
    batches.push(cues.slice(i, i + batchSize));
  }
  return batches;
}

export function validateIndices(sourceBatch: Cue[], returnedIndices: number[]): boolean {
  const expected = sourceBatch.map((c) => c.index);
  return expected.length === returnedIndices.length && expected.every((v, i) => v === returnedIndices[i]);
}

export function validateUpload(filename: string, content: string): { cues: Cue[] } | { error: string } {
  if (!filename.toLowerCase().endsWith(".srt")) {
    return { error: "請上傳 .srt 檔案" };
  }
  const cues = parseSrt(content);
  if (cues.length === 0) {
    return { error: "無法解析 SRT 內容，請確認檔案格式" };
  }
  const arrowCount = (content.match(/-->/g) ?? []).length;
  if (cues.length !== arrowCount) {
    return { error: "無法解析 SRT 內容，部分字幕可能因格式問題被跳過，請檢查檔案格式" };
  }
  return { cues };
}
```

Note: a fresh `RegExp` is constructed from `CUE_RE.source`/`.flags` inside `parseSrt` rather than reusing the module-level `CUE_RE` directly — a global (`g`) regex has mutable `lastIndex` state, and reusing one instance across calls (or concurrent Durable Object invocations) would corrupt parsing. This mirrors why Python's `re.finditer` doesn't have this problem (it's stateless per call).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all `srt.test.ts` cases green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add cf-worker/src/srt.ts cf-worker/test/srt.test.ts cf-worker/test/fixtures/sample_zh.srt
git commit -m "feat(cf-worker): port SRT parse/serialize/batch/upload-validation logic"
```

---

### Task 3: Prompt builder (`src/promptBuilder.ts`)

**Files:**
- Create: `cf-worker/src/promptBuilder.ts`
- Test: `cf-worker/test/promptBuilder.test.ts`

**Interfaces:**
- Consumes: `Cue` from `src/srt.ts` (Task 2).
- Produces (used by Task 8's orchestrator): `GlossaryRow` interface `{ chinese?: string; english?: string; locked?: number | boolean; [key: string]: unknown }`; `buildBatchPrompt(batch: Cue[], glossary: GlossaryRow[], contextTail: Array<[string, string]>): string`; `buildRetryPrompt(originalPrompt: string, errorDetail: string): string`.

- [ ] **Step 1: Write the failing tests**

`cf-worker/test/promptBuilder.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/promptBuilder.ts` does not exist.

- [ ] **Step 3: Implement `src/promptBuilder.ts`**

```ts
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
- 逐行 1:1 對應，輸出的行數、序號必須與輸入完全相同，不可合併或拆分。
- 海外志工姓名一律用漢語拼音，不用威妥瑪拼音。
- 經典/書名意譯，不要音譯。
- 不確定的詞彙翻譯，把該詞彙包成 [[UNSURE:中文詞|你採用的英文譯法]] 內嵌在譯文中，其餘照常翻譯，不要整行留白。

已鎖定詞彙庫（必須採用以下譯法）：
${glossaryLines || "（本批次無相關詞彙庫條目）"}

${contextLines ? "語境（前一批結尾）：\n" + contextLines : ""}

請翻譯以下字幕，輸出格式為每行「序號|||英文譯文」，不要加任何其他文字或說明：
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add cf-worker/src/promptBuilder.ts cf-worker/test/promptBuilder.test.ts
git commit -m "feat(cf-worker): port translation prompt builder"
```

---

### Task 4: Response parser (`src/responseParser.ts`)

**Files:**
- Create: `cf-worker/src/responseParser.ts`
- Test: `cf-worker/test/responseParser.test.ts`

**Interfaces:**
- Produces (used by Task 8's orchestrator): `TranslationParseError` (extends `Error`); `ParsedLine` interface `{ index: number; text: string; unsure: Array<[string, string]> }`; `parseLlmResponse(raw: string, expectedIndices: number[]): ParsedLine[]`.

- [ ] **Step 1: Write the failing tests**

`cf-worker/test/responseParser.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/responseParser.ts` does not exist.

- [ ] **Step 3: Implement `src/responseParser.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add cf-worker/src/responseParser.ts cf-worker/test/responseParser.test.ts
git commit -m "feat(cf-worker): port LLM response parser and UNSURE-marker handling"
```

---

### Task 5: LLM proxy client (`src/llmClient.ts`)

**Files:**
- Create: `cf-worker/src/llmClient.ts`
- Test: `cf-worker/test/llmClient.test.ts`

**Interfaces:**
- Produces (used by Task 8's orchestrator): `LlmApiError` (extends `Error`); `callLlm(prompt: string, baseUrl: string, apiKey: string, model: string, timeoutMs: number): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

`cf-worker/test/llmClient.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { callLlm, LlmApiError } from "../src/llmClient";

const BASE_URL = "https://sberecognition.tzuchi-org.tw/functions/v1/llm-proxy/v1";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("callLlm", () => {
  it("returns the message content on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "1|||hello world" } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callLlm("prompt text", BASE_URL, "sk-test", "Qwen3.6-35B-A3B", 60000);

    expect(result).toBe("1|||hello world");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/chat/completions`);
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("Qwen3.6-35B-A3B");
    expect(body.messages).toEqual([{ role: "user", content: "prompt text" }]);
  });

  it("raises immediately when the API key is missing", async () => {
    await expect(callLlm("prompt text", BASE_URL, "", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(LlmApiError);
    await expect(callLlm("prompt text", BASE_URL, "", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /LLM_PROXY_API_KEY/
    );
  });

  it("raises on an authentication error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "invalid key" }, 401)));
    await expect(callLlm("prompt text", BASE_URL, "sk-bad", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /金鑰無效/
    );
  });

  it("raises on a rate-limit error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited" }, 429)));
    await expect(callLlm("prompt text", BASE_URL, "sk-test", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /速率限制/
    );
  });

  it("raises on a connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    await expect(callLlm("prompt text", BASE_URL, "sk-test", "Qwen3.6-35B-A3B", 60000)).rejects.toThrow(
      /無法連線/
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/llmClient.ts` does not exist.

- [ ] **Step 3: Implement `src/llmClient.ts`**

```ts
export class LlmApiError extends Error {}

const MAX_RESPONSE_TOKENS = 8192;

export async function callLlm(
  prompt: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number
): Promise<string> {
  if (!apiKey) {
    throw new LlmApiError("未設定 LLM_PROXY_API_KEY，請確認 Cloudflare secret 已設定");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: MAX_RESPONSE_TOKENS,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new LlmApiError(`無法連線 LLM 代理伺服器：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new LlmApiError(`LLM 代理 API 金鑰無效或無權限，請確認設定：${await response.text()}`);
  }
  if (response.status === 429) {
    throw new LlmApiError(`LLM 代理已達速率限制，請稍後再試：${await response.text()}`);
  }
  if (response.status >= 400) {
    throw new LlmApiError(`LLM 代理錯誤（status ${response.status}）：${await response.text()}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add cf-worker/src/llmClient.ts cf-worker/test/llmClient.test.ts
git commit -m "feat(cf-worker): port LLM proxy client with timeout and error classification"
```

---

### Task 6: Glossary consistency check (`src/glossaryCheck.ts`)

**Files:**
- Create: `cf-worker/src/glossaryCheck.ts`
- Test: `cf-worker/test/glossaryCheck.test.ts`

**Interfaces:**
- Consumes: `Cue` from `src/srt.ts` (Task 2), `GlossaryRow` from `src/promptBuilder.ts` (Task 3).
- Produces (used by Task 8's orchestrator): `checkConsistency(zhCues: Cue[], enCues: Cue[], glossary: GlossaryRow[]): string[]`.

- [ ] **Step 1: Write the failing tests**

`cf-worker/test/glossaryCheck.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/glossaryCheck.ts` does not exist.

- [ ] **Step 3: Implement `src/glossaryCheck.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add cf-worker/src/glossaryCheck.ts cf-worker/test/glossaryCheck.test.ts
git commit -m "feat(cf-worker): port glossary consistency check"
```

---

### Task 7: Drust REST client (`src/drustClient.ts`)

**Files:**
- Create: `cf-worker/src/drustClient.ts`
- Test: `cf-worker/test/drustClient.test.ts`

**Interfaces:**
- Consumes: `GlossaryRow` from `src/promptBuilder.ts` (Task 3).
- Produces (used by Task 8's orchestrator): `DrustClient` class with constructor `(baseUrl: string, tenantId: string, anonToken: string, serviceToken: string)`, methods `fetchGlossary(): Promise<GlossaryRow[]>` and `insertPendingTerm(params: { term: string; stage: string; context: string; suggestedFix: string; videoTitle: string }): Promise<Record<string, unknown>>`.

- [ ] **Step 1: Write the failing tests**

`cf-worker/test/drustClient.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { DrustClient } from "../src/drustClient";

const BASE = "https://tcdrust.tzuchi-org.tw";
const TID = "9eec6c81-f435-4811-b86d-a4829edbecea";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchGlossary", () => {
  it("paginates until an empty page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          records: Array(200).fill({ chinese: "上人", english: "Dharma Master", locked: 1 }),
          total: 250,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ records: Array(50).fill({ chinese: "靜思", english: "Jing Si", locked: 1 }), total: 250 })
      )
      .mockResolvedValueOnce(jsonResponse({ records: [], total: 250 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new DrustClient(BASE, TID, "anon-tok", "service-tok");
    const rows = await client.fetchGlossary();

    expect(rows.length).toBe(250);
    expect(rows[0].chinese).toBe("上人");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer anon-tok");
  });

  it("stops once total is reached even if the API repeats the same page", async () => {
    const samePage = jsonResponse({
      records: Array(100).fill({ chinese: "上人", english: "Dharma Master", locked: 1 }),
      total: 250,
    });
    // Each call needs its own Response object (a Response body can only be read once).
    const fetchMock = vi.fn().mockImplementation(async () => samePage.clone());
    vi.stubGlobal("fetch", fetchMock);

    const client = new DrustClient(BASE, TID, "anon-tok", "service-tok");
    const rows = await client.fetchGlossary();

    expect(rows.length).toBe(300);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries once on a transient connection error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("transient blip"))
      .mockResolvedValueOnce(
        jsonResponse({ records: [{ chinese: "上人", english: "Dharma Master", locked: 1 }], total: 1 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new DrustClient(BASE, TID, "anon-tok", "service-tok");
    const rows = await client.fetchGlossary();

    expect(rows.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises after exhausting retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("still down"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new DrustClient(BASE, TID, "anon-tok", "service-tok");
    await expect(client.fetchGlossary()).rejects.toThrow("still down");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("insertPendingTerm", () => {
  it("uses the service token and returns the created row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 99,
        record: { id: 99, term: "某詞", stage: "translation", status: "pending" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new DrustClient(BASE, TID, "anon-tok", "service-tok");
    const row = await client.insertPendingTerm({
      term: "某詞",
      stage: "translation",
      context: "ctx",
      suggestedFix: "fix",
      videoTitle: "vid",
    });

    expect(row.id).toBe(99);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer service-tok");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.data.term).toBe("某詞");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/drustClient.ts` does not exist.

- [ ] **Step 3: Implement `src/drustClient.ts`**

```ts
import { GlossaryRow } from "./promptBuilder";

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DrustClient {
  private baseUrl: string;
  private tenantId: string;
  private anonToken: string;
  private serviceToken: string;

  constructor(baseUrl: string, tenantId: string, anonToken: string, serviceToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.tenantId = tenantId;
    this.anonToken = anonToken;
    this.serviceToken = serviceToken;
  }

  private tenantPath(path: string): string {
    return `${this.baseUrl}/t/${this.tenantId}/${path}`;
  }

  private async postWithRetry(url: string, jsonBody: unknown, headers: Record<string, string>): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await fetch(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(jsonBody),
        });
      } catch (e) {
        lastError = e;
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(RETRY_BACKOFF_MS);
        }
      }
    }
    throw lastError;
  }

  async fetchGlossary(): Promise<GlossaryRow[]> {
    const rows: GlossaryRow[] = [];
    let page = 1;
    const perPage = 200;
    let total: number | null = null;

    while (true) {
      const resp = await this.postWithRetry(
        this.tenantPath("collections/translation_glossary/list"),
        { page, per_page: perPage },
        { Authorization: `Bearer ${this.anonToken}` }
      );
      if (!resp.ok) {
        throw new Error(`Drust list failed: ${resp.status} ${await resp.text()}`);
      }
      const data = (await resp.json()) as { records?: GlossaryRow[]; total?: number };
      const batch = data.records ?? [];
      if (batch.length === 0) break;
      rows.push(...batch);
      if (total === null) total = data.total ?? null;
      if (total !== null && rows.length >= total) break;
      page += 1;
    }
    return rows;
  }

  async insertPendingTerm(params: {
    term: string;
    stage: string;
    context: string;
    suggestedFix: string;
    videoTitle: string;
  }): Promise<Record<string, unknown>> {
    const resp = await this.postWithRetry(
      this.tenantPath("records/pending_terms"),
      {
        data: {
          term: params.term,
          stage: params.stage,
          context: params.context,
          suggested_fix: params.suggestedFix,
          video_title: params.videoTitle,
        },
      },
      { Authorization: `Bearer ${this.serviceToken}` }
    );
    if (!resp.ok) {
      throw new Error(`Drust insert failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as { record?: Record<string, unknown> };
    return data.record ?? (data as Record<string, unknown>);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add cf-worker/src/drustClient.ts cf-worker/test/drustClient.test.ts
git commit -m "feat(cf-worker): port Drust REST client with pagination and retry"
```

---

### Task 8: Batch orchestrator (`src/orchestrator.ts`)

This is the direct port of `webtool/server.py`'s `translate_cues` function plus the pending-term dedupe/insert logic from the tail of its `/translate` route — split into two pure, dependency-injected functions so the Durable Object (Task 9) only has to call them and persist state, and so this task can be unit-tested exactly the way `tests/test_server.py` tests `translate_cues` (by injecting a fake `callLlm`).

**Files:**
- Create: `cf-worker/src/orchestrator.ts`
- Test: `cf-worker/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Cue` from `src/srt.ts`; `buildBatchPrompt`, `buildRetryPrompt`, `GlossaryRow` from `src/promptBuilder.ts`; `parseLlmResponse`, `TranslationParseError`, `ParsedLine` from `src/responseParser.ts`; `LlmApiError` from `src/llmClient.ts`; `checkConsistency` from `src/glossaryCheck.ts`.
- Produces (used by Task 9's Durable Object): `FAILURE_TEXT = "[翻譯失敗-請人工確認]"`; `BatchOutcome` interface `{ translated: Cue[]; warning: string | null; pendingRaw: Array<[string, string]>; newContextTail: Array<[string, string]> }`; `runOneBatch(params: { batch: Cue[]; glossary: GlossaryRow[]; contextTail: Array<[string, string]>; maxRetries: number; callLlm: (prompt: string) => Promise<string> }): Promise<BatchOutcome>`; `FinalResult` interface `{ filename: string; srt: string; warnings: string[]; pending_terms: Array<{ term: string; suggested_fix: string }> }` (the `pending_terms` field is deliberately snake_case, not camelCase — it's serialized straight into the JSON response `frontend/app.js` reads, matching the original Python API's `pending_terms` key); `finishTranslation(params: { videoTitle: string; zhCues: Cue[]; translated: Cue[]; warnings: string[]; pendingRaw: Array<[string, string]>; glossary: GlossaryRow[]; insertPendingTerm: (p: { term: string; stage: string; context: string; suggestedFix: string; videoTitle: string }) => Promise<unknown> }): Promise<FinalResult>`.

- [ ] **Step 1: Write the failing tests**

`cf-worker/test/orchestrator.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { runOneBatch, finishTranslation, FAILURE_TEXT } from "../src/orchestrator";
import { Cue, serializeSrt } from "../src/srt";
import { GlossaryRow } from "../src/promptBuilder";

const GLOSSARY: GlossaryRow[] = [{ chinese: "志工", english: "volunteer", locked: 1 }];

function cue(index: number, text: string): Cue {
  return { index, start: "00:00:00,000", end: "00:00:01,000", text };
}

describe("runOneBatch", () => {
  it("succeeds on the first attempt", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockResolvedValue("1|||English 1\n2|||English 2");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1", "English 2"]);
    expect(outcome.warning).toBeNull();
    expect(outcome.pendingRaw).toEqual([]);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });

  it("retries once then succeeds", async () => {
    const batch = [cue(1, "志工開示")];
    const callLlm = vi.fn().mockResolvedValueOnce("only one line, wrong format").mockResolvedValueOnce("1|||English 1");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.translated.map((c) => c.text)).toEqual(["English 1"]);
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it("marks the whole batch failed after exhausting retries", async () => {
    const batch = [cue(1, "志工開示"), cue(2, "第二句")];
    const callLlm = vi.fn().mockResolvedValue("garbled non-conforming output");

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 2, callLlm });

    expect(outcome.translated.every((c) => c.text === FAILURE_TEXT)).toBe(true);
    expect(outcome.warning).not.toBeNull();
    expect(outcome.newContextTail).toEqual([]);
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it("collects UNSURE markers into pendingRaw and the last 3 pairs into newContextTail", async () => {
    const batch = [cue(1, "甲"), cue(2, "乙"), cue(3, "丙"), cue(4, "丁")];
    const callLlm = vi
      .fn()
      .mockResolvedValue(
        "1|||[[UNSURE:甲詞|Jia term]] one\n2|||two\n3|||three\n4|||four"
      );

    const outcome = await runOneBatch({ batch, glossary: GLOSSARY, contextTail: [], maxRetries: 3, callLlm });

    expect(outcome.pendingRaw).toEqual([["甲詞", "Jia term"]]);
    expect(outcome.newContextTail).toEqual([
      ["乙", "two"],
      ["丙", "three"],
      ["丁", "four"],
    ]);
  });
});

describe("finishTranslation", () => {
  const zhCues = [cue(1, "守護生命"), cue(2, "新詞彙")];

  it("skips inserting a pending term that's already in the glossary", async () => {
    const glossary: GlossaryRow[] = [{ chinese: "守護生命", english: "Protect Life", locked: 1 }];
    const translated = [cue(1, "Protect Life talk"), cue(2, "New term test")];
    const insertPendingTerm = vi.fn().mockResolvedValue({ id: 1 });

    const result = await finishTranslation({
      videoTitle: "test",
      zhCues,
      translated,
      warnings: [],
      pendingRaw: [
        ["守護生命", "Protect Life"],
        ["新詞彙", "New term"],
      ],
      glossary,
      insertPendingTerm,
    });

    const insertedTerms = result.pending_terms.map((t) => t.term);
    expect(insertedTerms).toContain("新詞彙");
    expect(insertedTerms).not.toContain("守護生命");
    expect(insertPendingTerm).toHaveBeenCalledTimes(1);
    expect(insertPendingTerm).toHaveBeenCalledWith(
      expect.objectContaining({ term: "新詞彙", videoTitle: "test" })
    );
  });

  it("dedupes repeated pending terms and adds a warning if the Drust insert fails", async () => {
    const insertPendingTerm = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await finishTranslation({
      videoTitle: "test",
      zhCues,
      translated: [cue(1, "text"), cue(2, "text2")],
      warnings: [],
      pendingRaw: [
        ["新詞彙", "New term"],
        ["新詞彙", "New term again"],
      ],
      glossary: [],
      insertPendingTerm,
    });

    expect(insertPendingTerm).toHaveBeenCalledTimes(1);
    expect(result.pending_terms).toEqual([]);
    expect(result.warnings.some((w) => w.includes("新詞彙"))).toBe(true);
  });

  it("builds the output filename by stripping the [中文字幕] prefix", async () => {
    const result = await finishTranslation({
      videoTitle: "[中文字幕]某影片",
      zhCues: [],
      translated: [],
      warnings: [],
      pendingRaw: [],
      glossary: [],
      insertPendingTerm: vi.fn(),
    });
    expect(result.filename).toBe("[英文字幕]某影片.srt");
    expect(result.srt).toBe(serializeSrt([]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/orchestrator.ts` does not exist.

- [ ] **Step 3: Implement `src/orchestrator.ts`**

```ts
import { Cue, serializeSrt } from "./srt";
import { buildBatchPrompt, buildRetryPrompt, GlossaryRow } from "./promptBuilder";
import { parseLlmResponse, TranslationParseError } from "./responseParser";
import { LlmApiError } from "./llmClient";
import { checkConsistency } from "./glossaryCheck";

export const FAILURE_TEXT = "[翻譯失敗-請人工確認]";

export interface BatchOutcome {
  translated: Cue[];
  warning: string | null;
  pendingRaw: Array<[string, string]>;
  newContextTail: Array<[string, string]>;
}

export async function runOneBatch(params: {
  batch: Cue[];
  glossary: GlossaryRow[];
  contextTail: Array<[string, string]>;
  maxRetries: number;
  callLlm: (prompt: string) => Promise<string>;
}): Promise<BatchOutcome> {
  const { batch, glossary, contextTail, maxRetries, callLlm } = params;
  const expectedIndices = batch.map((c) => c.index);
  const originalPrompt = buildBatchPrompt(batch, glossary, contextTail);
  let prompt = originalPrompt;
  let parsed = null;
  let lastError = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = await callLlm(prompt);
      parsed = parseLlmResponse(raw, expectedIndices);
      break;
    } catch (e) {
      if (e instanceof TranslationParseError || e instanceof LlmApiError) {
        lastError = e.message;
        prompt = buildRetryPrompt(originalPrompt, lastError);
      } else {
        throw e;
      }
    }
  }

  if (parsed === null) {
    return {
      translated: batch.map((cue) => ({ ...cue, text: FAILURE_TEXT })),
      warning: `批次 ${batch[0].index}-${batch[batch.length - 1].index} 翻譯失敗（${lastError}），請人工確認`,
      pendingRaw: [],
      newContextTail: [],
    };
  }

  const translated = batch.map((cue, i) => ({ ...cue, text: parsed![i].text }));
  const pendingRaw = parsed.flatMap((line) => line.unsure);
  const pairs: Array<[string, string]> = batch.map((cue, i) => [cue.text, parsed![i].text]);

  return {
    translated,
    warning: null,
    pendingRaw,
    newContextTail: pairs.slice(-3),
  };
}

export interface FinalResult {
  filename: string;
  srt: string;
  warnings: string[];
  // snake_case: serialized straight into the JSON response frontend/app.js
  // reads, matching the original Python API's `pending_terms` key.
  pending_terms: Array<{ term: string; suggested_fix: string }>;
}

export async function finishTranslation(params: {
  videoTitle: string;
  zhCues: Cue[];
  translated: Cue[];
  warnings: string[];
  pendingRaw: Array<[string, string]>;
  glossary: GlossaryRow[];
  insertPendingTerm: (p: {
    term: string;
    stage: string;
    context: string;
    suggestedFix: string;
    videoTitle: string;
  }) => Promise<unknown>;
}): Promise<FinalResult> {
  const { videoTitle, zhCues, translated, glossary, insertPendingTerm } = params;
  const warnings = [...params.warnings, ...checkConsistency(zhCues, translated, glossary)];

  const zhTexts = zhCues.map((c) => c.text);
  const glossaryTerms = new Set(glossary.map((row) => row.chinese).filter((v): v is string => Boolean(v)));
  const seenTerms = new Set<string>();
  const pendingTerms: Array<{ term: string; suggested_fix: string }> = [];

  for (const [zhTerm, suggestedFix] of params.pendingRaw) {
    if (seenTerms.has(zhTerm)) continue;
    seenTerms.add(zhTerm);
    if (glossaryTerms.has(zhTerm)) continue;

    try {
      await insertPendingTerm({
        term: zhTerm,
        stage: "translation",
        context: zhTexts.find((t) => t.includes(zhTerm)) ?? "",
        suggestedFix,
        videoTitle,
      });
      pendingTerms.push({ term: zhTerm, suggested_fix: suggestedFix });
    } catch {
      warnings.push(`待確認詞彙「${zhTerm}」寫入 Drust 失敗，請自行記錄`);
    }
  }

  const outputFilename = `[英文字幕]${videoTitle.replace("[中文字幕]", "")}.srt`;
  return {
    filename: outputFilename,
    srt: serializeSrt(translated),
    warnings,
    pending_terms: pendingTerms,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add cf-worker/src/orchestrator.ts cf-worker/test/orchestrator.test.ts
git commit -m "feat(cf-worker): port batch translation orchestrator and pending-term dedupe"
```

---

### Task 9: Job Durable Object (`src/jobDurableObject.ts`)

Thin adapter: no dedicated unit test per Global Constraints (verified by `tsc` here and by the manual smoke test in Task 12). All actual translation logic is delegated to Task 8's `runOneBatch`/`finishTranslation`.

**Files:**
- Create: `cf-worker/src/jobDurableObject.ts`

**Interfaces:**
- Consumes: `Cue`, `splitBatches` from `src/srt.ts`; `runOneBatch`, `finishTranslation`, `FinalResult` from `src/orchestrator.ts`; `callLlm` from `src/llmClient.ts`; `DrustClient` from `src/drustClient.ts`; `GlossaryRow` from `src/promptBuilder.ts`.
- Produces (used by Task 10's routes): `Env` interface `{ LLM_PROXY_API_KEY: string; DRUST_ANON_TOKEN: string; DRUST_SERVICE_TOKEN: string; JOB: DurableObjectNamespace }`; `JobDurableObject` class (exported, bound as a Durable Object). Its `fetch()` handles `POST /start` (body `{ videoTitle: string; cues: Cue[] }`, returns 204) and `GET /status` (returns JSON `{ status: "processing" | "done" | "error"; progress: { done: number; total: number }; error: string | null; result: FinalResult | null }`).

- [ ] **Step 1: Implement `src/jobDurableObject.ts`**

```ts
import { Cue, splitBatches } from "./srt";
import { runOneBatch, finishTranslation, FinalResult } from "./orchestrator";
import { callLlm } from "./llmClient";
import { DrustClient } from "./drustClient";
import { GlossaryRow } from "./promptBuilder";

export interface Env {
  LLM_PROXY_API_KEY: string;
  DRUST_ANON_TOKEN: string;
  DRUST_SERVICE_TOKEN: string;
  JOB: DurableObjectNamespace;
}

const LLM_PROXY_BASE_URL = "https://sberecognition.tzuchi-org.tw/functions/v1/llm-proxy/v1";
const LLM_PROXY_MODEL = "Qwen3.6-35B-A3B";
const LLM_PROXY_TIMEOUT_MS = 180_000;
const DRUST_BASE = "https://tcdrust.tzuchi-org.tw";
const DRUST_TENANT_ID = "9eec6c81-f435-4811-b86d-a4829edbecea";
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

interface JobState {
  status: "processing" | "done" | "error";
  videoTitle: string;
  zhCues: Cue[];
  translated: Cue[];
  warnings: string[];
  pendingRaw: Array<[string, string]>;
  contextTail: Array<[string, string]>;
  glossary: GlossaryRow[] | null;
  nextBatchIndex: number;
  errorMessage: string | null;
  finalResult: FinalResult | null;
}

export class JobDurableObject implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private drustClient(): DrustClient {
    return new DrustClient(DRUST_BASE, DRUST_TENANT_ID, this.env.DRUST_ANON_TOKEN, this.env.DRUST_SERVICE_TOKEN);
  }

  private getJob(): Promise<JobState | undefined> {
    return this.state.storage.get<JobState>("job");
  }

  private putJob(job: JobState): Promise<void> {
    return this.state.storage.put("job", job);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      const body = (await request.json()) as { videoTitle: string; cues: Cue[] };
      const job: JobState = {
        status: "processing",
        videoTitle: body.videoTitle,
        zhCues: body.cues,
        translated: [],
        warnings: [],
        pendingRaw: [],
        contextTail: [],
        glossary: null,
        nextBatchIndex: 0,
        errorMessage: null,
        finalResult: null,
      };
      await this.putJob(job);
      await this.state.storage.setAlarm(Date.now());
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const job = await this.getJob();
      if (!job) return new Response("not found", { status: 404 });
      const totalBatches = Math.ceil(job.zhCues.length / BATCH_SIZE) || 1;
      return Response.json({
        status: job.status,
        progress: { done: job.nextBatchIndex, total: totalBatches },
        error: job.errorMessage,
        result: job.status === "done" ? job.finalResult : null,
      });
    }

    return new Response("not found", { status: 404 });
  }

  // Invariant: a Durable Object has exactly one pending alarm at a time.
  // While status === "processing" every fire either advances to the next
  // batch (re-arming an immediate alarm) or finishes the job. Only once the
  // job reaches a terminal state ("done"/"error") do we arm the 24h cleanup
  // alarm -- so a fire seen while already terminal IS that cleanup alarm.
  async alarm(): Promise<void> {
    const job = await this.getJob();
    if (!job) return;

    if (job.status !== "processing") {
      await this.state.storage.deleteAll();
      return;
    }

    if (job.glossary === null) {
      try {
        job.glossary = await this.drustClient().fetchGlossary();
      } catch {
        job.status = "error";
        job.errorMessage = "無法連線詞彙庫，請稍後再試";
        await this.putJob(job);
        await this.state.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
        return;
      }
    }

    const batches = splitBatches(job.zhCues, BATCH_SIZE);
    const batch = batches[job.nextBatchIndex];

    const outcome = await runOneBatch({
      batch,
      glossary: job.glossary,
      contextTail: job.contextTail,
      maxRetries: MAX_RETRIES,
      callLlm: (prompt) => callLlm(prompt, LLM_PROXY_BASE_URL, this.env.LLM_PROXY_API_KEY, LLM_PROXY_MODEL, LLM_PROXY_TIMEOUT_MS),
    });

    job.translated.push(...outcome.translated);
    if (outcome.warning) job.warnings.push(outcome.warning);
    job.pendingRaw.push(...outcome.pendingRaw);
    job.contextTail = outcome.newContextTail;
    job.nextBatchIndex += 1;

    if (job.nextBatchIndex < batches.length) {
      await this.putJob(job);
      await this.state.storage.setAlarm(Date.now());
      return;
    }

    job.finalResult = await finishTranslation({
      videoTitle: job.videoTitle,
      zhCues: job.zhCues,
      translated: job.translated,
      warnings: job.warnings,
      pendingRaw: job.pendingRaw,
      glossary: job.glossary,
      insertPendingTerm: (p) => this.drustClient().insertPendingTerm(p),
    });
    job.status = "done";
    await this.putJob(job);
    await this.state.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` (from `cf-worker/`)
Expected: exits 0. (`DurableObjectNamespace`/`DurableObjectState`/`DurableObject` types come from `@cloudflare/workers-types`, already installed in Task 1.)

- [ ] **Step 3: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS (same test count as after Task 8 — this task added no new test files).

- [ ] **Step 4: Commit**

```bash
git add cf-worker/src/jobDurableObject.ts
git commit -m "feat(cf-worker): add job Durable Object orchestrating batches via alarms"
```

---

### Task 10: Pages Functions API routes

**Files:**
- Create: `cf-worker/functions/api/jobs/index.ts`
- Create: `cf-worker/functions/api/jobs/[id].ts`

**Interfaces:**
- Consumes: `validateUpload` from `src/srt.ts`; `Env`, `JobDurableObject` from `src/jobDurableObject.ts`.
- Produces: `POST /api/jobs` (multipart form field `file`) → `201 { jobId: string }` or `400 { error: string }`. `GET /api/jobs/:id` → proxies the Durable Object's `/status` response, or `404 { error: string }` for an unknown id.

- [ ] **Step 1: Implement `functions/api/jobs/index.ts`**

```ts
import { validateUpload } from "../../../src/srt";
import { JobDurableObject, Env } from "../../../src/jobDurableObject";

export { JobDurableObject };

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const formData = await context.request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "請上傳 .srt 檔案" }, { status: 400 });
  }

  const content = await file.text();
  const result = validateUpload(file.name, content);
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const videoTitle = file.name.replace(/\.srt$/i, "");
  const id = context.env.JOB.newUniqueId();
  const stub = context.env.JOB.get(id);
  await stub.fetch("https://job/start", {
    method: "POST",
    body: JSON.stringify({ videoTitle, cues: result.cues }),
  });

  return Response.json({ jobId: id.toString() }, { status: 201 });
};
```

- [ ] **Step 2: Implement `functions/api/jobs/[id].ts`**

```ts
import { Env } from "../../../src/jobDurableObject";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  let id: DurableObjectId;
  try {
    id = context.env.JOB.idFromString(context.params.id as string);
  } catch {
    return Response.json({ error: "找不到此翻譯工作" }, { status: 404 });
  }

  const stub = context.env.JOB.get(id);
  const resp = await stub.fetch("https://job/status");
  if (resp.status === 404) {
    return Response.json({ error: "找不到此翻譯工作" }, { status: 404 });
  }
  return resp;
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` (from `cf-worker/`)
Expected: exits 0. (`PagesFunction`/`DurableObjectId` types also come from `@cloudflare/workers-types`.)

- [ ] **Step 4: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS (unchanged test count — routes have no dedicated unit tests per Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add cf-worker/functions/api/jobs/index.ts "cf-worker/functions/api/jobs/[id].ts"
git commit -m "feat(cf-worker): add POST /api/jobs and GET /api/jobs/:id Pages Functions"
```

---

### Task 11: Frontend static page

**Files:**
- Create: `cf-worker/frontend/index.html`
- Create: `cf-worker/frontend/app.js`
- Create: `cf-worker/frontend/style.css` (copy of `webtool/static/style.css`)

**Interfaces:**
- Consumes: `POST /api/jobs` and `GET /api/jobs/:id` from Task 10, calling from the same origin (Cloudflare Pages serves both the static files and the Functions routes from one deployment).

- [ ] **Step 1: Copy the existing stylesheet verbatim**

```bash
mkdir -p cf-worker/frontend
cp webtool/static/style.css cf-worker/frontend/style.css
```

- [ ] **Step 2: Create `cf-worker/frontend/index.html`**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>慈濟字幕中翻英工具</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>中文字幕 → 英文字幕</h1>
  <p>上傳已完成糾錯/格式化的中文 .srt，系統會依詞彙庫產出英文 .srt。</p>

  <input type="file" id="fileInput" accept=".srt">
  <button id="translateBtn">開始翻譯</button>

  <div id="status"></div>
  <div id="warnings"></div>
  <div id="pendingTerms"></div>
  <a id="downloadLink" style="display:none" download>下載英文字幕</a>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `cf-worker/frontend/app.js`**

```js
document.getElementById("translateBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("fileInput");
  const statusEl = document.getElementById("status");
  const warningsEl = document.getElementById("warnings");
  const pendingEl = document.getElementById("pendingTerms");
  const downloadLink = document.getElementById("downloadLink");

  if (!fileInput.files.length) {
    statusEl.textContent = "請先選擇一個 .srt 檔案";
    return;
  }

  statusEl.textContent = "上傳中...";
  warningsEl.textContent = "";
  pendingEl.textContent = "";
  downloadLink.style.display = "none";

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);

  let jobId;
  try {
    const resp = await fetch("/api/jobs", { method: "POST", body: formData });
    const data = await resp.json();
    if (!resp.ok) {
      statusEl.textContent = "錯誤：" + data.error;
      return;
    }
    jobId = data.jobId;
  } catch (err) {
    statusEl.textContent = "發生錯誤：" + err;
    return;
  }

  statusEl.textContent = "翻譯中，請稍候（可能需要數分鐘）...";

  const poll = async () => {
    let data;
    try {
      const resp = await fetch(`/api/jobs/${jobId}`);
      data = await resp.json();
    } catch (err) {
      statusEl.textContent = "發生錯誤：" + err;
      return;
    }

    if (data.status === "error") {
      statusEl.textContent = "錯誤：" + data.error;
      return;
    }

    if (data.status === "processing") {
      statusEl.textContent = `翻譯中，請稍候...（${data.progress.done}/${data.progress.total} 批次）`;
      setTimeout(poll, 2500);
      return;
    }

    statusEl.textContent = "翻譯完成！";
    const result = data.result;
    if (result.warnings.length) {
      warningsEl.textContent = "警告：\n" + result.warnings.join("\n");
    }
    if (result.pending_terms.length) {
      pendingEl.textContent =
        "本次新增待確認詞彙：\n" +
        result.pending_terms.map((t) => `${t.term} -> ${t.suggested_fix}`).join("\n");
    }
    const blob = new Blob([result.srt], { type: "text/plain;charset=utf-8" });
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = result.filename;
    downloadLink.textContent = `下載 ${result.filename}`;
    downloadLink.style.display = "block";
  };

  setTimeout(poll, 2500);
});
```

- [ ] **Step 4: Commit**

```bash
git add cf-worker/frontend/index.html cf-worker/frontend/app.js cf-worker/frontend/style.css
git commit -m "feat(cf-worker): add polling-based frontend for upload/progress/download"
```

---

### Task 12: Wrangler config, secrets, and end-to-end smoke test

**Files:**
- Create: `cf-worker/wrangler.toml`
- Modify: `cf-worker/.gitignore` (already excludes `.dev.vars` from Task 1 — no change needed, verify only)

**Interfaces:**
- Produces: a deployable Cloudflare Pages project configuration with the `JOB` Durable Object binding wired to `JobDurableObject`.

- [ ] **Step 1: Create `cf-worker/wrangler.toml`**

```toml
name = "srt-translator"
compatibility_date = "2026-08-27"
pages_build_output_dir = "frontend"

[[durable_objects.bindings]]
name = "JOB"
class_name = "JobDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["JobDurableObject"]
```

- [ ] **Step 2: Create local dev secrets file for manual testing**

Create `cf-worker/.dev.vars` (already gitignored, never commit):
```
LLM_PROXY_API_KEY=<value from cf-worker/../.env's LLM_PROXY_API_KEY>
DRUST_ANON_TOKEN=<value from cf-worker/../.env's DRUST_ANON_TOKEN, post-rotation>
DRUST_SERVICE_TOKEN=<value from cf-worker/../.env's DRUST_SERVICE_TOKEN, post-rotation>
```

- [ ] **Step 3: Run the full automated test suite one more time**

Run (from `cf-worker/`): `npm test && npm run typecheck`
Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 4: Manual end-to-end smoke test**

Run: `wrangler pages dev frontend` (from `cf-worker/`, with `.dev.vars` present)
Then in a browser, open the printed local URL and upload `tests/fixtures/sample_zh.srt` (copied to `cf-worker/test/fixtures/sample_zh.srt` in Task 2 — use that same 12-cue file for a fast real check against the live LLM proxy and Drust).

Expected:
- Upload returns a `jobId` immediately (no long wait on the POST itself).
- Status text updates to show batch progress, then "翻譯完成！".
- A download link appears; the downloaded `.srt` has 12 cues with English text.
- No console errors in the browser dev tools.

If this fails, check (in order): `wrangler pages dev` startup logs for a "Durable Object class not found" binding error (fix `wrangler.toml`'s `class_name`/export wiring in Task 10's `functions/api/jobs/index.ts`), then the Network tab for the actual `/api/jobs` and `/api/jobs/:id` response bodies (surfaces LLM-proxy or Drust errors directly, since `callLlm`/`DrustClient` error messages are designed to be descriptive).

- [ ] **Step 5: Commit**

```bash
git add cf-worker/wrangler.toml
git commit -m "chore(cf-worker): add wrangler.toml with Durable Object binding"
```

---

## Deployment (post-plan, not a task with automated verification)

Once all tasks pass and the manual smoke test succeeds:
1. `wrangler pages secret put LLM_PROXY_API_KEY`, `wrangler pages secret put DRUST_ANON_TOKEN`, `wrangler pages secret put DRUST_SERVICE_TOKEN` (from `cf-worker/`) — use the **rotated** Drust token values, not the ones that leaked in the public GitHub repo.
2. `npm run deploy` (i.e. `wrangler pages deploy frontend`).
3. Share the resulting `*.pages.dev` URL with colleagues.
