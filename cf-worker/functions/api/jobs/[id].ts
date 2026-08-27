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
