"""The pattern analyzer, exercised without a network.

A fake client stands where Claude will stand, so what is tested is everything
deterministic around the model: the assembled request (model, system, the caps
that select files), the text it reads back off the response, the empty-repo
degenerate case, and the error path where the model itself throws.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import patterns  # noqa: E402
from patterns import analyze  # noqa: E402

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


HEADER = "The repository's files follow. Write the code pattern helper prompt."


class Text:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class NonText:
    """A block the analyzer must skip — it has no .text to read."""

    type = "tool_use"


class Response:
    def __init__(self, content: list, stop_reason: str = "end_turn") -> None:
        self.content = content
        self.stop_reason = stop_reason


class FakeMessages:
    def __init__(self, responses: list[Response]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs) -> Response:
        self.calls.append(kwargs)
        return self.responses.pop(0)


class FakeClient:
    def __init__(self, *responses: Response) -> None:
        self.messages = FakeMessages(list(responses))


class RaisingClient:
    """Stands where a model outage would: create() raises."""

    class _Messages:
        def create(self, **kwargs):
            raise RuntimeError("the model is down")

    def __init__(self) -> None:
        self.messages = RaisingClient._Messages()


def test_analyze_builds_the_request() -> None:
    print("test_analyze_builds_the_request")
    client = FakeClient(Response([Text("## patterns\n")]))
    # Given out of order, to prove the traversal sorts.
    analyze({"z.py": "z = 1\n", "a.py": "a = 1\n"}, client, "model-x")

    call = client.messages.calls[0]
    ok(len(client.messages.calls) == 1, "exactly one model call is made")
    ok(call["model"] == "model-x", "the caller's model is used")
    ok(call["system"] == patterns.SYSTEM, "the analyzer's system prompt rides verbatim")
    ok(call["max_tokens"] == patterns.MAX_TOKENS, "the configured output ceiling rides")
    messages = call["messages"]
    ok(len(messages) == 1 and messages[0]["role"] == "user", "the repo is a single user turn")

    prompt = messages[0]["content"]
    ok(prompt.startswith(HEADER), "the instruction header leads the prompt")
    ok("--- a.py ---\na = 1" in prompt, "a file rides under its own path marker, content intact")
    ok(prompt.index("--- a.py ---") < prompt.index("--- z.py ---"), "files ride in sorted order for a stable prompt")


def test_analyze_returns_joined_stripped_text() -> None:
    print("test_analyze_returns_joined_stripped_text")
    client = FakeClient(Response([Text("  ## Patterns\n"), NonText(), Text("\nnaming: snake\n  ")]))
    result = analyze({"a.py": "x = 1\n"}, client, "m")
    ok(result == "## Patterns\n\nnaming: snake", "text blocks join, non-text is skipped, and the whole is stripped")


def test_analyze_empty_response_is_empty_string() -> None:
    print("test_analyze_empty_response_is_empty_string")
    client = FakeClient(Response([NonText()]))
    ok(analyze({"a.py": "x = 1\n"}, client, "m") == "", "a response with no text reads back as empty, not a crash")


def test_analyze_handles_an_empty_file_set() -> None:
    print("test_analyze_handles_an_empty_file_set")
    client = FakeClient(Response([Text("nothing to describe")]))
    result = analyze({}, client, "m")
    ok(result == "nothing to describe", "an empty repo still returns the model's text")
    prompt = client.messages.calls[0]["messages"][0]["content"]
    ok(prompt == HEADER, "with no files the prompt is just the instruction header")
    ok("---" not in prompt and "Not shown" not in prompt, "no file markers and no skip note when there are no files")


def test_analyze_caps_oversized_and_total() -> None:
    print("test_analyze_caps_oversized_and_total")
    files = {
        "a.py": "x = 1\n",             # tiny — always included
        "big.bin": "A" * 150_000,      # over MAX_FILE_BYTES on its own
        "b.py": "B" * 90_000,
        "c.py": "C" * 90_000,
        "d.py": "D" * 90_000,          # a+b+c+d ~ 270KB, still under the total
        "e.py": "E" * 90_000,          # would push past MAX_TOTAL_BYTES — dropped
    }
    client = FakeClient(Response([Text("## the patterns")]))
    analyze(files, client, "m")
    prompt = client.messages.calls[0]["messages"][0]["content"]

    ok("B" * 90_000 in prompt and "D" * 90_000 in prompt, "files under both caps ride whole")
    ok("A" * 150_000 not in prompt, "a single oversized file's content is skipped")
    ok("E" * 90_000 not in prompt, "the running total cap drops the file that would overflow it")
    ok("Not shown" in prompt, "the prompt tells the model some files were withheld")
    ok("big.bin" in prompt and "e.py" in prompt, "each withheld file is named in the skip note")


def test_analyze_without_skips_has_no_note() -> None:
    print("test_analyze_without_skips_has_no_note")
    client = FakeClient(Response([Text("patterns")]))
    analyze({"a.py": "x = 1\n", "b.py": "y = 2\n"}, client, "m")
    ok("Not shown" not in client.messages.calls[0]["messages"][0]["content"], "nothing withheld, no skip note")


def test_analyze_propagates_a_model_error() -> None:
    print("test_analyze_propagates_a_model_error")
    try:
        analyze({"a.py": "x = 1\n"}, RaisingClient(), "m")
        ok(False, "a model error must propagate")
    except RuntimeError as error:
        ok("the model is down" in str(error), "the analyzer lets the model's error surface to its caller")


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
