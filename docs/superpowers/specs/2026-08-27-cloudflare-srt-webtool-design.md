# SRT 中翻英網頁工具 — Cloudflare 多人版設計規格書

日期：2026-08-27
前置文件：`docs/superpowers/specs/2026-08-25-srt-translation-webtool-design.md`（本機 Flask 版，MVP，已完成並持續保留）

## 背景與目的

本機 Flask 版（`webtool/`）已完成並通過 36 項測試，翻譯引擎已改用機構地端 LLM
代理（`sberecognition.tzuchi-org.tw/functions/v1/llm-proxy`，vLLM-MLX 叢集）。
現在要讓**同事**（不只使用者本人）也能使用，不依賴使用者的筆電或任何單一機器
持續開機 —— 因此改建置一份**完全無伺服器（serverless）的 Cloudflare 版本**，
與本機 Flask 版並存（Flask 版不刪除，仍可本機使用）。

## 範圍（MVP）

**包含：**
- Cloudflare Pages 靜態前端：上傳中文 `.srt` → 顯示進度 → 下載英文 `.srt`
- Cloudflare Pages Functions API + Durable Object：背景批次翻譯、輪詢式進度回報
- 沿用既有 Drust `translation_glossary`／`pending_terms` 邏輯（1:1 移植自
  `webtool/drust_client.py`）
- 沿用既有翻譯 prompt／回應解析／重試／UNSURE 標記邏輯（1:1 移植自
  `webtool/translator.py`）
- 開放網址，無登入（同事任何人有連結即可使用）

**不包含（明確排除）：**
- 使用者帳號/權限系統
- 詞彙庫線上編輯介面
- 刪除或取代本機 Flask 版

## 為何不能照搬 Flask 版架構

Cloudflare Workers/Pages Functions 不支援執行 Python/Flask，且**單一 HTTP
請求無法安全地跑完一個 1000–2000 條字幕的翻譯工作**（依 50 條一批切分，
可能是 20–40 次序列 LLM 呼叫，每次數秒到數十秒，總計可能長達數分鐘 ——
超出瀏覽器與 Worker 單一請求應該負擔的時長）。因此改採**背景工作 + 輪詢**
模式，而非「上傳後單一請求等到底」。

## 架構總覽

```
瀏覽器（同事，任何人）
   │  上傳中文 .srt
   ▼
Cloudflare Pages（靜態前端：上傳／進度條／下載）
   │  POST /api/jobs   { filename, content }
   ▼
Pages Function（API 路由）
   1. 解析 SRT（複用 srt.ts 的 parseSrt）、驗證格式
   2. 建立一個新的 Durable Object 實例（jobId = crypto.randomUUID()）
   3. 把 cues 陣列存進 DO storage，狀態設為 "processing"
   4. 排一個立即觸發的 alarm
   5. 回傳 { jobId } 給瀏覽器（此請求到此結束，不等翻譯完成）

瀏覽器輪詢 GET /api/jobs/:id every ~2.5s
   ↓
Durable Object（每個翻譯工作一個實例，狀態存在 DO storage）
   alarm() 被觸發時：
     1. 若詞彙庫尚未載入 → 呼叫 Drust 讀取 translation_glossary（僅第一次）
     2. 取下一批未處理的 50 條 cue
     3. 組 prompt（含相關詞彙庫條目 + 前一批結尾 3 句作語境）
     4. 呼叫 LLM 代理（Qwen3.6-35B-A3B），失敗依規則重試
     5. 解析回應、寫入這批的翻譯結果與新發現的 UNSURE 詞彙到 DO storage
     6. 更新進度（已完成批次數／總批次數）
     7. 若還有未處理批次 → 重新排一個立即 alarm；否則：
        - 組出完整英文 SRT
        - 執行詞彙一致性檢查（產生警告清單）
        - 把去重後的 UNSURE/新詞彙寫入 Drust pending_terms
        - 狀態設為 "done"，存下最終結果

瀏覽器輪詢看到 "done" → 顯示警告/待確認清單 → 觸發下載
```

## 元件細節（`cf-worker/` 新資料夾，與既有 `webtool/` 並存）

以下每個檔案都是既有 Python 模組的 1:1 邏輯移植（同樣的規則、同樣的格式契約），
以便沿用既有測試案例作為驗收基準：

| 新檔案（TypeScript） | 對應現有模組 | 職責 |
|---|---|---|
| `src/srt.ts` | `srt_utils.py` | `parseSrt`/`serializeSrt`（同一份正規表示式規則）、`splitBatches`（50 條一批） |
| `src/promptBuilder.ts` | `translator.py: build_batch_prompt` | 組出與現行完全相同的中文 prompt（規則摘要＋鎖定詞彙庫子集＋前情語境＋序號\|\|\|文字格式的 cue 列表） |
| `src/responseParser.ts` | `translator.py: parse_claude_response` | 解析 `序號\|\|\|英文譯文` 格式、抽出 `[[UNSURE:中文\|英文]]` 內嵌標記、驗證回傳序號與預期序號完全一致 |
| `src/llmClient.ts` | `translator.py: call_llm` | `fetch` 呼叫 `LLM_PROXY_BASE_URL/chat/completions`，Bearer token，`model="Qwen3.6-35B-A3B"`，逾時處理（`AbortController`），401/403/429/≥400 分類錯誤訊息 |
| `src/glossaryCheck.ts` | `glossary_check.py` | 鎖定詞彙一致性檢查（原文含鎖定詞但譯文未含 → 警告） |
| `src/drustClient.ts` | `drust_client.py` | `fetchGlossary`（分頁 `per_page=200`，連線錯誤重試 3 次、間隔 1 秒）、`insertPendingTerm`（service token） |
| `src/jobDurableObject.ts` | `server.py: translate_cues` + `/translate` route | 上表「Durable Object」欄位所有步驟的狀態機、alarm 排程、重試迴圈（每批 `MAX_RETRIES=3`，失敗則整批標記為 `[翻譯失敗-請人工確認]` 並加入警告，語境清空） |
| `functions/api/jobs/index.ts` | `server.py: translate()` 的前半（驗證上傳、建立工作） | `POST /api/jobs`：驗證 `.srt`、解析、cue 數與 `-->` 出現次數比對（同現有 malformed-SRT 檢查）、建立 DO、回傳 jobId |
| `functions/api/jobs/[id].ts` | `server.py: translate()` 的回傳格式 | `GET /api/jobs/:id`：查詢 DO 狀態，回傳 `{status, progress, warnings?, pending_terms?, filename?, srt?}` |
| `frontend/index.html` / `app.js` / `style.css` | `webtool/templates/index.html` / `static/*` | 沿用相同版面與文案，把「送出後等 response」改成「送出→拿 jobId→輪詢」 |

**設定與密鑰**（`wrangler secret put`，絕不進 repo）：
- `LLM_PROXY_API_KEY`
- `DRUST_SERVICE_TOKEN`
- `DRUST_ANON_TOKEN`（非機敏但仍走 secret，與其他機敏值一致管理）

**維持不變的常數**：`BATCH_SIZE=50`、`MAX_RETRIES=3`、模型改為 `Qwen3.6-35B-A3B`
（既有 Python 版仍用 `gpt-oss-120b`，兩者為獨立設定，互不影響）。

## 錯誤處理

- **上傳驗證失敗**（非 `.srt`、格式錯誤、cue 數與 `-->` 數不符）：`POST /api/jobs`
  直接回 400，不建立 Durable Object。
- **單批 LLM 呼叫失敗**（逾時、格式不符、API 錯誤）：依 `build_retry_prompt`
  規則重試，上限 3 次；全部失敗則該批 cue 文字設為 `[翻譯失敗-請人工確認]`，
  加入警告，繼續下一批（不中止整個工作）。
- **alarm handler 拋出未捕捉例外**：Cloudflare Durable Object 對失敗的 alarm
  會自動重試（含 backoff），這是平台內建行為，不需自行實作額外重試層。
- **Drust 連線失敗**：
  - 讀取詞彙庫失敗 → 整個工作標記為 `error`（沿用 Flask 版「沒詞彙庫不可硬翻」
    的既有決策）。
  - 寫入 `pending_terms` 失敗（單一詞彙）→ 依現有邏輯僅加入警告，不影響整體
    工作結果。
- **工作過期清理**：Durable Object 同一時間只能有一個排程中的 alarm，因此
  清理 alarm **不能**在 DO 建立時就排（會被逐批處理用的立即 alarm 覆蓋掉）。
  改為在工作進入終止狀態（`done` 或 `error`）、確定不再需要排批次 alarm
  之後，才排一個 24 小時後觸發的清理 alarm，到期即刪除該工作的 storage，
  避免無人下載的工作永久佔用。

## 測試

沿用現有 36 項 Python 測試涵蓋的案例，改用 **Vitest +
`@cloudflare/vitest-pool-workers`**（Cloudflare 官方推薦的 Workers/Durable
Object 本機測試方案）逐一移植：
- SRT 解析/序列化 round-trip、多行 cue、缺空行等 malformed 案例
- 批次切分與序號驗證
- prompt 組成（含詞彙庫子集、語境）與回應解析（含 UNSURE 標記、序號不符偵測）
- 重試成功／重試後仍失敗（標記 `[翻譯失敗-請人工確認]`）
- 已存在詞彙庫的詞不重複寫入 `pending_terms`
- 詞彙一致性警告

另以 `wrangler pages dev` 本機起服務，手動跑一次真實的中文 SRT（含 Drust／
LLM 代理皆為真實呼叫）作為上線前的一次性驗收。

## 部署

`wrangler pages deploy`，單一 Cloudflare Pages 專案（前端靜態檔 + Pages
Functions API + Durable Object binding）。網域可用 Cloudflare 預設的
`*.pages.dev` 子網域，或掛機構自有網域（待定，非本次 MVP 必要項）。

## 待確認/後續事項

- Drust `DRUST_ANON_TOKEN`／`DRUST_SERVICE_TOKEN` 的舊值（曾硬編碼於公開
  GitHub repo 的 `webtool/config.py`）**尚待使用者於 Drust 後台重新產生**；
  新 Cloudflare 版部署前，`wrangler secret put` 應使用重新產生後的新值。
- 是否需要幫既有公開 GitHub repo（`yangwt-2702/-SRT`）改為 private，本次
  尚未決定，維持公開。
