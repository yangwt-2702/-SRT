import { validateUpload } from "../../../src/srt";
import { JobDurableObject, Env } from "../../../src/jobDurableObject";

export { JobDurableObject };

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const formData = await context.request.formData();
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
  const id = context.env.JOB.newUniqueId();
  const stub = context.env.JOB.get(id);
  await stub.fetch("https://job/start", {
    method: "POST",
    body: JSON.stringify({ videoTitle, cues: result.cues }),
  });

  return Response.json({ jobId: id.toString() }, { status: 201 });
};
