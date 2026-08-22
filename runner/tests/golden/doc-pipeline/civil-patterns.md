```markdown
# Repo Conventions

**Layout**: `src/{services,steps,tools}/<name>/main.py` (or flat `<name>.py` for tools) — one node per file/folder, each independently deployable. Every module opens with a short docstring stating its role in the pipeline, often citing a PRD section (e.g. "PRD 7.2: ...") to justify why the code is shaped this way.

**Types**: Domain data is modeled as `TypedDict` classes co-located in the same file as the function that uses them (`Record`, `Document`, `SearchHit`, etc.), one per shape, named after the noun they represent (input vs. output gets distinct names, e.g. `Record` → `EnrichedRecord`, `Document` → `NormalizedDocument`). `from __future__ import annotations` is present in every file.

**Function naming**: The public entrypoint of a step/service is always named `handler(x: X) -> Y`, taking one TypedDict and returning one TypedDict. Tool modules instead export a plainly-named function (`search_docs`) matching its capability, with no `handler`. Private helpers are prefixed with a leading underscore (`_related_ids`) and placed after `handler`.

**Style**: Fully sync, no async anywhere. Every public function has a full type signature (params and return); helper functions are typed too. Docstrings are one-line, imperative/descriptive, used on modules always and on functions when the behavior isn't obvious from the name/signature alone (trivial handlers like `save_record.handler` skip a docstring). Module-level comments explain *why* (design rationale, PRD references) rather than *what*.

**Imports**: Always start with `from __future__ import annotations`, then stdlib imports (`re`, `unicodedata`, `typing`) in alphabetical order, one per line, no third-party or cross-module imports observed yet.

**Error handling**: None present — no try/except, no validation, no raised exceptions. Placeholder/stub logic (e.g. `_related_ids`, `search_docs`) returns trivial values with a comment noting it's a stand-in, using `del` on unused params rather than leaving them unreferenced.
```