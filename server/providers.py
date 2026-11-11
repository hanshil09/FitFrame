"""Model providers behind one interface: images + prompt + schema in, parsed object out.
Swap with MODEL_PROVIDER in .env. The API key stays on the server."""
import json
import os
import time
from typing import Type, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class Provider:
    name = "base"
    model = ""

    def generate(self, images: list[bytes], prompt: str, schema: Type[T], temperature: float = 0.2) -> T:
        raise NotImplementedError


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self, fail_fast=False):
        from google import genai
        from google.genai import types
        self.fail_fast = fail_fast
        http_options = types.HttpOptions(timeout=20000) if fail_fast else None
        self.client = genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options=http_options)
        # Free-tier quotas are per model per day, so when one runs out we move to the next
        first = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
        extra = os.environ.get("GEMINI_FALLBACK_MODELS", "gemini-3.7-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite")
        self.models = [first] + [m.strip() for m in extra.split(",") if m.strip() and m.strip() != first]
        self.model = self.models[0]
        self.calls = 0
        self.tokens_in = 0
        self.tokens_out = 0

    def generate(self, images, prompt, schema, temperature=0.2):
        from google.genai import types, errors
        parts = [types.Part.from_bytes(data=img, mime_type="image/png") for img in images] + [prompt]
        cfg = types.GenerateContentConfig(temperature=temperature, response_mime_type="application/json", response_schema=schema)
        delay = 4.0
        attempts = min(len(self.models), 3) if self.fail_fast else 8
        for attempt in range(attempts):
            try:
                r = self.client.models.generate_content(model=self.model, contents=parts, config=cfg)
                self.calls += 1
                if r.usage_metadata:
                    self.tokens_in += r.usage_metadata.prompt_token_count or 0
                    self.tokens_out += r.usage_metadata.candidates_token_count or 0
                if r.parsed is not None:
                    return r.parsed
                return schema.model_validate(json.loads(r.text))
            except errors.APIError as e:
                code, msg = getattr(e, "code", None), str(e)
                daily = code == 429 and "PerDay" in msg
                gone = code == 404
                if self.fail_fast:
                    if code in (404, 429, 500, 502, 503, 504) and attempt + 1 < attempts:
                        self.model = self.models[attempt + 1]
                        continue
                    raise
                if daily or gone:
                    i = self.models.index(self.model)
                    if i + 1 < len(self.models):
                        self.model = self.models[i + 1]   # quota for this model is used up today
                        continue
                    raise RuntimeError("Daily free-tier quota is used up on every configured Gemini model. "
                                       "Try again tomorrow, or set a paid key / another provider in .env.") from e
                # per-minute limit or a transient server error: back off and retry
                if code in (429, 500, 502, 503, 504) and attempt < 7:
                    time.sleep(delay)
                    delay = min(delay * 2, 60)
                    continue
                raise
        raise RuntimeError("model call failed after retries")


def make_provider(*, fail_fast=False) -> Provider:
    name = os.environ.get("MODEL_PROVIDER", "gemini")
    if name == "gemini":
        return GeminiProvider(fail_fast=fail_fast)
    raise ValueError(f"Unknown MODEL_PROVIDER {name!r} (supported: gemini)")
