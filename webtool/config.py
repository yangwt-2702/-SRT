import os

from dotenv import load_dotenv

load_dotenv()

DRUST_BASE = "https://tcdrust.tzuchi-org.tw"
DRUST_TENANT_ID = "9eec6c81-f435-4811-b86d-a4829edbecea"
DRUST_ANON_TOKEN = "drust_qikOlcix2GBK-PxsAU8rLC0rEbGhC0AaUMR2_tAma0w"
DRUST_SERVICE_TOKEN = "drust_uQcGNoyEbu6CY5abgvB95fhYokLTaavGVskwaegZ6vw"

# LLM proxy API key must never be hardcoded here -- it's a real billing/quota
# credential. Set it in a local .env file (see .env.example), which is
# gitignored.
LLM_PROXY_BASE_URL = "https://sberecognition.tzuchi-org.tw/functions/v1/llm-proxy/v1"
LLM_PROXY_API_KEY = os.environ.get("LLM_PROXY_API_KEY")
LLM_PROXY_MODEL = "gpt-oss-120b"
LLM_PROXY_TIMEOUT_SECONDS = 180

BATCH_SIZE = 50
MAX_RETRIES = 3

PORT = 8787
