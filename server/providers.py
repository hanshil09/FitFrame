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
        # Without a limit, a stalled connection leaves the scan hanging forever. A kit scan reads every
        # page of the manual in one call, which can take well over 20 s, so even fail-fast waits 2 minutes.
        http_options = types.HttpOptions(timeout=int(os.environ.get("GEMINI_TIMEOUT_MS", 120000 if fail_fast else 180000)))
        self.client = genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options=http_options)
        # Free-tier quotas are per model per day, so when one runs out we move to the next
        first = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
        extra = os.environ.get("GEMINI_FALLBACK_MODELS", "gemini-3.7-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite")
        self.models = [first] + [m.strip() for m in extra.split(",") if m.strip() and m.strip() != first]
        self.model = self.models[0]
        self.spent = set()       # models whose daily quota is used up or that do not exist
        self.calls = 0
        self.tokens_in = 0
        self.tokens_out = 0

    def generate(self, images, prompt, schema, temperature=0.2):
        from google.genai import types, errors
        parts = [types.Part.from_bytes(data=img, mime_type="image/png") for img in images] + [prompt]
        cfg = types.GenerateContentConfig(temperature=temperature, response_mime_type="application/json", response_schema=schema)
        delay, busy = 4.0, 0
        # An overloaded model is only skipped for the call that hit it; the next call tries the best model again
        self.model = next((m for m in self.models if m not in self.spent), self.models[-1])
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
            except Exception as e:
                if "timeout" in type(e).__name__.lower() and not self.fail_fast and attempt < 2:
                    continue   # the call stalled; try it again
                if not isinstance(e, errors.APIError):
                    raise
                code, msg = getattr(e, "code", None), str(e)
                daily = code == 429 and "PerDay" in msg
                gone = code == 404
                if self.fail_fast:
                    if code in (404, 429, 500, 502, 503, 504) and attempt + 1 < attempts:
                        self.model = self.models[attempt + 1]
                        continue
                    raise
                if daily or gone:
                    self.spent.add(self.model)
                    i = self.models.index(self.model)
                    if i + 1 < len(self.models):
                        self.model = self.models[i + 1]   # quota for this model is used up today
                        continue
                    raise RuntimeError("Daily free-tier quota is used up on every configured Gemini model. "
                                       "Try again tomorrow, or set a paid key / another provider in .env.") from e
                # per-minute limit or a transient server error: back off and retry
                if code in (429, 500, 502, 503, 504) and attempt < 7:
                    busy += code != 429
                    i = self.models.index(self.model)
                    if busy >= 3 and i + 1 < len(self.models):
                        self.model, busy, delay = self.models[i + 1], 0, 4.0   # this model stays overloaded; use the next
                        continue
                    time.sleep(delay)
                    delay = min(delay * 2, 60)
                    continue
                raise
        raise RuntimeError("model call failed after retries")


class ProviderError(Exception):
    """An HTTP failure from a provider, with the status in .code like Gemini's errors."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _json_object(text):
    """The reply's JSON object, without code fences or any words around it."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in the reply")
    return text[start:end + 1]


class OllamaProvider(Provider):
    """Ollama's hosted API (ollama.com) or a local Ollama server (set OLLAMA_HOST).
    Ollama's cloud does not enforce a JSON schema, so the schema goes in the prompt and the
    reply is parsed and checked here, with one retry that shows the model its mistake."""
    name = "ollama"
    # Vision model families, best first. Every available tag of these is tried in turn (biggest first)
    # until one is allowed on this account; OLLAMA_MODEL (comma-separated) overrides the list.
    PREFERRED = ("gemma4", "kimi-k3", "mistral-large-4", "qwen3-vl", "minimax-m3", "glm-5.3-flash",
                 "deepseek-v4.1-flash", "minimax-m3.1-flash", "mimo-v2.6-flash", "inkling-2-small",
                 "kimi-k3.1-pro", "ministral-3", "gemma3")

    def __init__(self, fail_fast=False):
        self.host = os.environ.get("OLLAMA_HOST", "https://ollama.com").rstrip("/")
        self.key = os.environ.get("OLLAMA_API_KEY", "")
        if "ollama.com" in self.host and not self.key:
            raise KeyError("OLLAMA_API_KEY")
        self.chosen = [m.strip() for m in os.environ.get("OLLAMA_MODEL", "").split(",") if m.strip()]
        self.model = self.chosen[0] if self.chosen else ""
        self.refused = {}        # model -> why the account may not use it (402 no credits, 403, 404)
        self.calls = self.tokens_in = self.tokens_out = 0
        try:
            import ssl
            import certifi
            self.ssl = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            self.ssl = None

    def _request(self, path, body=None):
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["Authorization"] = "Bearer " + self.key
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urlopen(Request(self.host + path, data=data, headers=headers), timeout=300, context=self.ssl) as reply:
                return json.load(reply)
        except HTTPError as error:
            detail = error.read().decode(errors="ignore")[:300]
            raise ProviderError(error.code, f"Ollama {path} returned {error.code}: {detail}") from error

    def _candidates(self):
        if self.chosen:
            return self.chosen
        names = [m.get("name") or m.get("model") or "" for m in self._request("/api/tags").get("models", [])]

        def size(name):   # biggest tag of a family first, e.g. gemma4:31b before gemma4:e4b
            digits = "".join(c if c.isdigit() else " " for c in name.split(":", 1)[-1]).split()
            return max(map(int, digits), default=0)
        ordered = []
        for family in self.PREFERRED:
            ordered += sorted((n for n in names if n.split(":")[0] == family), key=size, reverse=True)
        if not ordered:
            raise ProviderError(404, "No vision model from OllamaProvider.PREFERRED is available to this key. "
                                     "Set OLLAMA_MODEL in .env to one that reads images.")
        return ordered

    def generate(self, images, prompt, schema, temperature=0.2):
        import base64
        content = (prompt + "\n\nReply with only one JSON object and no other text. It must match this JSON schema:\n"
                   + json.dumps(schema.model_json_schema()))
        messages = [{"role": "user", "content": content,
                     "images": [base64.b64encode(image).decode() for image in images if image]}]
        for model in [m for m in self._candidates() if m not in self.refused]:
            try:
                return self._ask(model, list(messages), schema, temperature)
            except ProviderError as error:
                if error.code not in (402, 403, 404):
                    raise
                self.refused[model] = error.code      # not on this plan: try the next model
        tried = ", ".join(f"{m} ({c})" for m, c in self.refused.items())
        raise ProviderError(402, "Ollama refused every vision model for this account (402 = needs credits "
                                 "or a subscription): " + tried)

    def _ask(self, model, messages, schema, temperature):
        self.model = model
        problem = None
        for _ in range(2):
            reply = self._request("/api/chat", {"model": model, "messages": messages, "stream": False,
                                                "options": {"temperature": temperature}})
            self.calls += 1
            self.tokens_in += reply.get("prompt_eval_count") or 0
            self.tokens_out += reply.get("eval_count") or 0
            text = (reply.get("message") or {}).get("content", "")
            try:
                return schema.model_validate_json(_json_object(text))
            except Exception as error:
                problem = str(error)[:400]
                messages += [{"role": "assistant", "content": text},
                             {"role": "user", "content": "That reply did not match the schema (" + problem
                              + "). Reply again with only the corrected JSON object."}]
        raise ProviderError(422, f"Ollama model {model} did not return valid JSON: {problem}")


def make_provider(*, fail_fast=False) -> Provider:
    name = os.environ.get("MODEL_PROVIDER", "gemini")
    if name == "gemini":
        return GeminiProvider(fail_fast=fail_fast)
    if name == "ollama":
        return OllamaProvider(fail_fast=fail_fast)
    raise ValueError(f"Unknown MODEL_PROVIDER {name!r} (supported: gemini, ollama)")
