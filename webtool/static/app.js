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

  statusEl.textContent = "翻譯中，請稍候（可能需要數分鐘）...";
  warningsEl.textContent = "";
  pendingEl.textContent = "";
  downloadLink.style.display = "none";

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);

  try {
    const resp = await fetch("/translate", { method: "POST", body: formData });
    const data = await resp.json();

    if (!resp.ok) {
      statusEl.textContent = "錯誤：" + data.error;
      return;
    }

    statusEl.textContent = "翻譯完成！";
    if (data.warnings.length) {
      warningsEl.textContent = "警告：\n" + data.warnings.join("\n");
    }
    if (data.pending_terms.length) {
      pendingEl.textContent = "本次新增待確認詞彙：\n" +
        data.pending_terms.map(t => `${t.term} -> ${t.suggested_fix}`).join("\n");
    }

    const blob = new Blob([data.srt], { type: "text/plain;charset=utf-8" });
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = data.filename;
    downloadLink.textContent = `下載 ${data.filename}`;
    downloadLink.style.display = "block";
  } catch (err) {
    statusEl.textContent = "發生錯誤：" + err;
  }
});
