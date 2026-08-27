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

    let glossary = await this.state.storage.get<GlossaryRow[]>("glossary");
    if (glossary === undefined) {
      try {
        glossary = await this.drustClient().fetchGlossary();
        await this.state.storage.put("glossary", glossary);
      } catch {
        job.status = "error";
        job.errorMessage = "無法連線詞彙庫，請稍後再試";
        await this.putJob(job);
        await this.state.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
        return;
      }
    }

    try {
      const batches = splitBatches(job.zhCues, BATCH_SIZE);
      const batch = batches[job.nextBatchIndex];

      const outcome = await runOneBatch({
        batch,
        glossary,
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
        glossary,
        insertPendingTerm: (p) => this.drustClient().insertPendingTerm(p),
      });
      job.status = "done";
      await this.putJob(job);
      await this.state.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
    } catch (e) {
      console.error("jobDurableObject alarm error:", e);
      job.status = "error";
      job.errorMessage = `處理過程發生未預期錯誤：${e instanceof Error ? e.message : String(e)}`;
      await this.putJob(job);
      await this.state.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
    }
  }
}
