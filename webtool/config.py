import os

from dotenv import load_dotenv

load_dotenv()

DRUST_BASE = "https://tcdrust.tzuchi-org.tw"
DRUST_TENANT_ID = "9eec6c81-f435-4811-b86d-a4829edbecea"

# Drust and LLM proxy credentials must never be hardcoded here -- they're
# real billing/access credentials. Set them in a local .env file (see
# .env.example), which is gitignored.
DRUST_ANON_TOKEN = os.environ.get("DRUST_ANON_TOKEN")
DRUST_SERVICE_TOKEN = os.environ.get("DRUST_SERVICE_TOKEN")
LLM_PROXY_BASE_URL = "https://sberecognition.tzuchi-org.tw/functions/v1/llm-proxy/v1"
LLM_PROXY_API_KEY = os.environ.get("LLM_PROXY_API_KEY")
LLM_PROXY_MODEL = "gpt-oss-120b"
LLM_PROXY_TIMEOUT_SECONDS = 180

BATCH_SIZE = 50
MAX_RETRIES = 3

PORT = 8787
