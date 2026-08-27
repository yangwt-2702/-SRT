# webtool/server.py
from flask import Flask, request, jsonify, render_template

from webtool import config
from webtool.srt_utils import parse_srt, serialize_srt, split_batches, validate_indices, Cue
from webtool.drust_client import DrustClient
from webtool.glossary_check import check_consistency
from webtool.translator import (
    build_batch_prompt, build_retry_prompt, parse_claude_response,
    call_llm, TranslationParseError, LlmApiError,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

drust_client = DrustClient(
    config.DRUST_BASE, config.DRUST_TENANT_ID,
    config.DRUST_ANON_TOKEN, config.DRUST_SERVICE_TOKEN,
)


def translate_cues(cues: list[Cue], glossary: list[dict], batch_size: int,
                    max_retries: int, video_title: str):
    translated: list[Cue] = []
    warnings: list[str] = []
    pending: list[tuple[str, str]] = []
    context_tail: list[tuple[str, str]] = []

    for batch in split_batches(cues, batch_size):
        expected_indices = [c.index for c in batch]
        original_prompt = build_batch_prompt(batch, glossary, context_tail)
        prompt = original_prompt
        parsed = None
        last_error = ""

        for attempt in range(max_retries):
            try:
                raw = call_llm(prompt, config.LLM_PROXY_BASE_URL, config.LLM_PROXY_API_KEY,
                                config.LLM_PROXY_MODEL, config.LLM_PROXY_TIMEOUT_SECONDS)
                parsed = parse_claude_response(raw, expected_indices)
                break
            except (TranslationParseError, LlmApiError) as e:
                last_error = str(e)
                prompt = build_retry_prompt(original_prompt, last_error)

        if parsed is None:
            for cue in batch:
                translated.append(Cue(cue.index, cue.start, cue.end, "[翻譯失敗-請人工確認]"))
            warnings.append(
                f"批次 {batch[0].index}-{batch[-1].index} 翻譯失敗（{last_error}），請人工確認"
            )
            context_tail = []
            continue

        for cue, line in zip(batch, parsed):
            translated.append(Cue(cue.index, cue.start, cue.end, line.text))
            pending.extend(line.unsure)
        context_tail = [(cue.text, line.text) for cue, line in zip(batch, parsed)][-3:]

    return translated, warnings, pending


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/translate", methods=["POST"])
def translate():
    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename.lower().endswith(".srt"):
        return jsonify({"error": "請上傳 .srt 檔案"}), 400

    content = uploaded.stream.read().decode("utf-8-sig")
    cues = parse_srt(content)
    if not cues:
        return jsonify({"error": "無法解析 SRT 內容，請確認檔案格式"}), 400
    if len(cues) != content.count("-->"):
        return jsonify({"error": "無法解析 SRT 內容，部分字幕可能因格式問題被跳過，請檢查檔案格式"}), 400

    try:
        glossary = drust_client.fetch_glossary()
    except Exception:
        return jsonify({"error": "無法連線詞彙庫，請稍後再試"}), 502

    video_title = uploaded.filename.rsplit(".", 1)[0]
    translated, warnings, pending_raw = translate_cues(
        cues, glossary, config.BATCH_SIZE, config.MAX_RETRIES, video_title,
    )

    warnings.extend(check_consistency(cues, translated, glossary))

    zh_text_by_index = {c.index: c.text for c in cues}
    glossary_terms = {row.get("chinese") for row in glossary if row.get("chinese")}
    seen_terms = set()
    pending_terms = []
    for zh_term, suggested_fix in pending_raw:
        if zh_term in seen_terms:
            continue
        seen_terms.add(zh_term)
        if zh_term in glossary_terms:
            continue
        try:
            drust_client.insert_pending_term(
                term=zh_term, stage="translation",
                context=next((t for t in zh_text_by_index.values() if zh_term in t), ""),
                suggested_fix=suggested_fix, video_title=video_title,
            )
            pending_terms.append({"term": zh_term, "suggested_fix": suggested_fix})
        except Exception:
            warnings.append(f"待確認詞彙「{zh_term}」寫入 Drust 失敗，請自行記錄")

    output_filename = f"[英文字幕]{video_title.replace('[中文字幕]', '')}.srt"
    return jsonify({
        "filename": output_filename,
        "srt": serialize_srt(translated),
        "warnings": warnings,
        "pending_terms": pending_terms,
    })
