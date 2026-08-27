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
