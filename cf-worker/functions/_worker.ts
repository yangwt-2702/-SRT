import { validateUpload } from "../src/srt";
import { JobDurableObject, Env as JobEnv } from "../src/jobDurableObject";

export { JobDurableObject };

interface Env extends JobEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

async function handleCreateJob(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const fileEntry = formData.get("file");
  if (!fileEntry || typeof fileEntry === "string") {
    return Response.json({ error: "請上傳 .srt 檔案" }, { status: 400 });
  }

  const file = fileEntry as File;
  const content = await file.text();
  const result = validateUpload(file.name, content);
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const videoTitle = file.name.replace(/\.srt$/i, "");
  const id = env.JOB.newUniqueId();
  const stub = env.JOB.get(id);
  const startResp = await stub.fetch("https://job/start", {
    method: "POST",
    body: JSON.stringify({ videoTitle, cues: result.cues }),
  });
  if (!startResp.ok) {
    return Response.json({ error: "無法建立翻譯工作，請稍後再試" }, { status: 502 });
  }

  return Response.json({ jobId: id.toString() }, { status: 201 });
}

async function handleGetJob(jobId: string, env: Env): Promise<Response> {
  let id: DurableObjectId;
  try {
    id = env.JOB.idFromString(jobId);
  } catch {
    return Response.json({ error: "找不到此翻譯工作" }, { status: 404 });
  }

  const stub = env.JOB.get(id);
  const resp = await stub.fetch("https://job/status");
  if (resp.status === 404) {
    return Response.json({ error: "找不到此翻譯工作" }, { status: 404 });
  }
  return resp;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/jobs") {
      return handleCreateJob(request, env);
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      return handleGetJob(jobMatch[1], env);
    }

    return env.ASSETS.fetch(request);
  },
};
