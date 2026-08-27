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
