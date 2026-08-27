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
