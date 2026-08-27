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
