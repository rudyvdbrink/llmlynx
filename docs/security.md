# Security layer: prompt injection and malware

Agents read web pages, search results and attached files. This layer guards what reaches the model from those, and what the model can then do with a URL. The code is in `src/server/security/` (entry point: `engine.ts`), the two scanners are the `guard` and `clamav` containers. Nothing is sent to a service outside the server; only ClamAV's signature updates come from the internet.

## Threat model

- **Indirect prompt injection.** Text in a page, a search result or a file is written to instruct the model ("ignore your instructions and ...").
- **URL exfiltration.** A model that was talked into it puts conversation data in a URL and fetches it, which hands the data to that server.
- **Malicious uploads.** A file the user attaches, or content a tool fetched, carries malware.

Not in scope: a malicious user of their own account, and a model that is malicious without outside influence.

## What happens on a detection

| Detection | What happens |
| --- | --- |
| Virus in a file the user attaches | The file is refused and never stored. The chip says why; the user goes on without it. |
| Prompt injection in a file the user attaches | Not checked: the file is the user's own, and the model gets it. |
| Virus in content from the internet | The content is discarded. The model is told so and the reply goes on. Nobody is asked. |
| Prompt injection in content from the internet | The reply pauses with a warning. The user chooses **Remove and continue** or **Stop**. The whole result is withheld from the model either way. |
| Content that could not be checked (scanner down or too slow) | Treated as not safe: withheld from the model, or the file not stored, with a message that says it could not be checked. |

The choice is enforced on the server: a paused reply only goes on when its owner answers `/api/chat/pauses/:id`.

## The checks

- **Attached files** (`checkFile`, `POST /api/uploads`): checked when they are attached, while the user types. The virus scan and the conversion to text run in parallel. A clean file becomes a draft; sending moves drafts into the message, so nothing is converted or scanned twice. Their text is not scanned for injections.
- **Before a tool call** (`checkBeforeCall`): the URL rules below. Synchronous, on data in memory.
- **After a tool call** (`checkAfterCall`): for tools whose result comes from the internet, Unicode tag characters are removed, then the injection scan and the virus scan (text and images) run in parallel, within 8 seconds.
- **Security context** (`context.ts`): rebuilt from the stored conversation at each request. It holds the known URLs and whether the conversation is tainted (a flagged tool result is in it). Taint never goes away.
- **Audit log** (`SecurityEvent`): every scan, warning, block and dialog choice, with a host and a SHA-256 hash, never content or a full URL. Written in one go when the reply ends.
- **Scanners**: identical text is scored once (cache of 500 verdicts). A scanner that failed or timed out is skipped for 30 seconds; its content then counts as not checked.

### URL rules

For tools that fetch a URL the model chose (`web_read`, `web_read_rendered`, `web_screenshot`), in this order:

| The URL | Verdict | Reason code |
| --- | --- | --- |
| is known: it appears in a user message, in the text of an attached file or in a tool result | allow | |
| is unknown and shows an exfiltration signal | block | `url_exfil` |
| is unknown and the conversation is tainted | block | `url_unknown_tainted` |
| is unknown otherwise | allow, logged | `url_unknown` |

URLs are compared exactly after normalizing (scheme and host in lower case, punycode, no default port, no fragment). Exfiltration signals, on the decoded URL (constants in `limits.ts`): a query string over 256 characters; a path segment or query value of 40 or more characters that is hex, base64 or has more than 4.0 bits of entropy per character; a run of 32 letters and digits that also occurs in the user's messages or files. A blocked call tells the model to find the page with `web_search` or to answer without it.

## Decisions

Given with the task:

- Only the dialog of the table exists. A blocked URL and a virus never lead to a question.
- Flagged internet content is withheld whole; no part of a page is passed on, and there is no "keep anyway" for it.
- Images are not scanned for injections, only for viruses.
- The model runs as FP32 ONNX, not quantized.
- The fail mode and the URL thresholds are fixed, not settings.

Made while building:

- ClamAV runs from `clamav/clamav-debian:1.5.4`: the official `clamav/clamav` tags (1.4, 1.5, stable) have no linux/arm64 manifest.
- The ClamAV container keeps five capabilities (CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID); with fewer, its start script or freshclam fails.
- A virus is acted on in monitor mode too: a file with a virus is never stored, in any mode but off.
- The model comes as an ONNX file from `rudyvdbrink/Llama-Prompt-Guard-2-22M-onnx` (and `-86M-onnx`), the project's own public conversion of Meta's weights, so a build needs no Hugging Face account, no token and no export step. Every file is pinned by revision and SHA-256 (`tools/guard/build/models.json`). The pinned `22m` file was compared with Meta's original weights run in PyTorch on 16 texts: the same token ids, and scores that differ by at most 0.000002. The `86m` file was not compared.
- The model files moved from `gravitee-io/Llama-Prompt-Guard-2-*-onnx` (a third party's conversion, which it can remove at any time) to the project's own repositories on 2026-11-16. `model.onnx`, `tokenizer.json`, `config.json` and `NOTICE` have the same SHA-256 as before; `LICENSE` differs only by a newline at the end.
- The build runs the model on a known injection and on a harmless sentence, and stops when it does not tell them apart.
- The guard takes its turn per batch of 8 chunks, first come first served, so a page scan does not wait behind a long document.
- Files the user attaches are scanned for viruses only, not for prompt injections (decided on 2026-11-11): scanning a large file such as a `package-lock.json` took minutes, and the file is the user's own. Its text reaches the model in full, does not taint the conversation, and its URLs count as known. The dialog for such files (Use anyway / Remove) is gone.
- The circuit breaker opens when a scanner does not answer, not when the guard answers that it cannot scan a text.
- Base64 is told from a slug of words (such as a Wikipedia title) by how often it changes between lower case, upper case and digits.
- The shared-text signal looks at a URL's path and query, not its host, or every page of a site the user named would match.
- URLs in an agent's system prompt are not known URLs: only the three sources above count.
- A file that failed its check does not block sending: the message goes without it. A warning or error that shows after an early send cancels that send.
- Stop ends the reply like the composer's stop button: nothing is written in the model's name.
- In monitor mode nothing is stored on a tool step; the taint then only holds for the running reply.
- Error texts llmlynx writes itself (tool down, wrong arguments) are not scanned.

## Known limits

- A classifier can be bypassed by an attack that adapts to it. The URL rules are the real boundary: they do not depend on the classifier.
- Attached files are not scanned for injections: a document the user got from someone else can carry instructions aimed at the model. The URL rules still apply to what the model then does.
- Images are not scanned for injections: text in a screenshot, photo or scanned PDF page reaches a model that can see.
- Virus signatures only catch known malware.
- The web tools hand the app text and screenshots, never downloaded files, so a virus hit on internet content will be rare.
- A tainted conversation stays tainted: unknown URLs stay blocked in it. Start a new conversation to get rid of the taint.
- A long slug of words (some of 50 characters and up) can exceed the entropy threshold and is then blocked, although it is harmless. The model is told to go through `web_search`.
- Data can still leave in small pieces (under 32 characters per URL) or through search queries, which go to the search engines.
- The 22m model is trained on English; use 86m for other languages if the server is fast enough.
- A paused reply keeps its connection open for up to 10 minutes; a network that cuts idle connections counts as Stop.

## Tuning

**Threshold.** Set `SECURITY_MODE=monitor` for a while: every check runs and is logged, but only a virus is acted on. Then look at the scores:

```bash
sqlite3 data/llmlynx.db "SELECT round(score, 2) AS score, verdict, tool, host FROM SecurityEvent WHERE \"check\" = 'injection' AND score IS NOT NULL ORDER BY score DESC LIMIT 50;"
```

Pick `GUARD_THRESHOLD` (default `0.5`) between the scores of the pages that were fine and those that were not, restart the guard (`docker compose up -d guard`), and go back to `enforce`. A higher threshold interrupts less and lets more through.

**Speed.** On the server:

```bash
docker compose run --rm --no-deps guard python /app/bench.py
```

The target on a Raspberry Pi 5 with `22m` is under 2 seconds for a 12,000-character page; the app gives up on a tool result's scan after 8 seconds. Dev-machine numbers, not the Pi's: AMD Ryzen 5 7535HS (6 cores), with the real `22m` model in its container: load 1.3 s, one 512-token chunk 155 ms, the page (7 chunks) 1.2 s, peak memory 1.0 GB. Expect the Pi to be several times slower, and `86m` several times slower again.

**Memory on the Pi (8 GB).** clamd holds about 1 GB of signatures (962 MB measured); `ConcurrentDatabaseReload no` keeps an update from doubling that. The guard takes about 1 GB with `22m`. Both have a limit of 2 GB. Next to them run the browser (limit 1.5 GB) and files (limit 1.5 GB) containers, which only use memory while they work.

## Later: fetching files

A tool that downloads a file declares `fetchesUrl` and `untrustedOutput`, so its URL passes the URL rules, and hands the bytes to `checkFile` with source `"internet"`, which scans its text for injections too (within 180 seconds). That already follows the table: a virus discards the file, an injection withholds it and asks for the pause dialog (via `flaggedResult`, with the file's name as the source), an unchecked file is withheld. Nothing else changes.

## Later: code execution

A `run_code` tool adds an `exec` effect to `ToolEffects` and its own pre-call checks to `PRE_CALL_CHECKS`. It runs in a fresh, locked-down container without network or secrets, has its code scanned before it runs and its output scanned like any internet content, and can reuse the pause dialog for an approval step.
