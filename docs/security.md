# Security layer: prompt injection and malware

Agents read web pages, search results, attached files and downloads, and run code in the chat's sandbox. This layer guards what reaches the model from those, and what enters and leaves the sandbox. The code is in `src/server/security/` (entry point: `engine.ts`), the two scanners are the `guard` and `clamav` containers. Nothing is sent to a service outside the server; only ClamAV's signature updates come from the internet.

## Threat model

- **Indirect prompt injection.** Text in a page, a search result or a file is written to instruct the model ("ignore your instructions and ...").
- **Malicious uploads.** A file the user attaches, or content a tool fetched, carries malware.
- **Code execution.** Code the model writes runs on the server, also when injected text talked the model into it, and the packages it installs may be malicious. It must not reach the network, the app, the other containers, other chats or the server's secrets, and what it prints or writes must not instruct the model.

Not in scope: a malicious user of their own account, and a model that is malicious without outside influence.

## What happens on a detection

| Detection | What happens |
| --- | --- |
| Virus in a file the user attaches | The file is refused and never stored. The chip says why; the user goes on without it. |
| Prompt injection in a file the user attaches | Not checked: the file is the user's own, and the model gets it. |
| Virus in content from the internet | The content is discarded. The model is told so and the reply goes on. Nobody is asked. |
| Prompt injection in content from the internet | The reply pauses with a warning. The user chooses **Remove and continue** or **Stop**. The whole result is withheld from the model either way. |
| Content that could not be checked (scanner down or too slow) | Treated as not safe: withheld from the model, or the file not stored, with a message that says it could not be checked. |

The chat's sandbox counts as untrusted. Each way into it or out of it has a check:

| What | Check | On a detection |
| --- | --- | --- |
| The downloaded file | Virus scan, then its text is scanned for prompt injections (as a file from the internet, up to 3 minutes) | Virus: discarded. Injection: not stored, the reply pauses (Remove and continue, or Stop) and the chat is tainted. Not checked: not stored |
| `run_code`, before the run | Virus scan of the code. In a tainted chat, the user is asked first | Virus: not run. Tainted: the reply pauses with a dialog to run the code or not |
| `install_packages` | Only from PyPI and npm, with no builds and no install scripts; a virus scan of everything downloaded before anything is installed; what pip and npm report is scanned for injections. In a tainted chat, the user is asked first | Virus or not checked: nothing installed. Injection in the report: withheld, and the reply pauses |
| What the code printed, for the model | Hidden Unicode tag characters removed, then the injection and virus scans, as for a web page | Withheld, the reply pauses, and the chat is tainted |
| Files the code made | Virus scan, before they are stored or shown | Discarded; the model is told so |
| A file made by code or downloaded, when the model reads it | Injection scan of the part it reads, unless that was scanned; the verdict is kept with the file | Withheld, the reply pauses, and the chat is tainted |
| An artifact shown to the user | Only files that passed the checks above; HTML and SVG only in a sandboxed frame (see Decisions) | |
| `git` | Its files: a virus scan of everything a command made or changed, in one archive, before any of it is kept. What git printed: as a web page. Downloads (clone, fetch, pull) only from public addresses over HTTPS | Virus or not checked: nothing of the command kept, its history included. Injection in what it printed: withheld, the reply pauses, and the chat is tainted |
| `share_file` | None of its own: it only gives files that are in the sandbox, which were checked when they came in | |
| `view_image` | None of its own: it shows the model images that are in the sandbox, which were checked for viruses when they came in. Images are not scanned for injections (see Known limits) | |

The choice is enforced on the server: a paused reply only goes on when its owner answers `/api/chat/pauses/:id`. Its dialog has a chevron that opens the chunk the guard flagged (its chunk with the highest score, as the guard read it), as plain text in a box that scrolls: no link in it can be clicked and no image in it loads. The chunk is kept with the tool step, so it shows again after the choice and after a reload; the model never gets it, and the audit log holds no content.

## The checks

- **Attached files** (`checkFile`, `POST /api/uploads`): checked when they are attached, while the user types. The virus scan and the conversion to text run in parallel. A clean file becomes a draft; sending moves drafts into the message, so nothing is converted or scanned twice. Their text is not scanned for injections.
- **After a tool call** (`checkAfterCall`): for tools whose result comes from the internet or from code, Unicode tag characters are removed, then the injection scan and the virus scan (text and images) run in parallel, within 8 seconds. A run whose output is withheld keeps the files it made.
- **Before code runs** (`runToolLoop`, `awaitApproval`): in a tainted chat, `run_code` and `install_packages` (the tools with the `exec` effect) wait for the user: run it, or go on without the run. Then the code is scanned for viruses.
- **Reading an untrusted file** (`checkFileRead`): the part of a file made by code, or downloaded, that `read_file` gives the model is scanned for injections, unless that part was scanned before; the verdicts are kept with the file. A download's whole text was scanned when it arrived.
- **Security context** (`context.ts`): rebuilt from the stored conversation at each request. It holds whether the conversation is tainted (a flagged tool result is in it). Taint never goes away.
- **Audit log** (`SecurityEvent`): every scan, block and dialog choice, with a host and a SHA-256 hash, never content or a full URL. Written in one go when the reply ends.
- **Scanners**: identical text is scored once (cache of 500 verdicts). A scanner that failed or timed out is skipped for 30 seconds; its content then counts as not checked.

## Decisions

Given with the task:

- Only the dialog of the table exists. A virus never leads to a question.
- Flagged internet content is withheld whole; no part of a page is passed on, and there is no "keep anyway" for it.
- Images are not scanned for injections, only for viruses.
- The model runs as FP32 ONNX, not quantized.
- The fail mode is fixed, not a setting.

Made while building:

- ClamAV runs from `clamav/clamav-debian:1.5.4`: the official `clamav/clamav` tags (1.4, 1.5, stable) have no linux/arm64 manifest.
- The ClamAV container keeps five capabilities (CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID); with fewer, its start script or freshclam fails.
- A virus is acted on in monitor mode too: a file with a virus is never stored, in any mode but off.
- The model comes as an ONNX file from `rudyvdbrink/Llama-Prompt-Guard-2-22M-onnx` (and `-86M-onnx`), the project's own public conversion of Meta's weights, so a build needs no Hugging Face account, no token and no export step. Every file is pinned by revision and SHA-256 (`tools/guard/build/models.json`). The pinned `22m` file was compared with Meta's original weights run in PyTorch on 16 texts: the same token ids, and scores that differ by at most 0.000002. The `86m` file was not compared.
- The model files moved from `gravitee-io/Llama-Prompt-Guard-2-*-onnx` (a third party's conversion, which it can remove at any time) to the project's own repositories on 2026-11-16. `model.onnx`, `tokenizer.json`, `config.json` and `NOTICE` have the same SHA-256 as before; `LICENSE` differs only by a newline at the end.
- The build runs the model on a known injection and on a harmless sentence, and stops when it does not tell them apart.
- The guard takes its turn per batch of 8 chunks, first come first served, so a page scan does not wait behind a long document.
- Files the user attaches are scanned for viruses only, not for prompt injections (decided on 2026-11-11): scanning a large file such as a `package-lock.json` took minutes, and the file is the user's own. Its text reaches the model in full, and does not taint the conversation. The dialog for such files (Use anyway / Remove) is gone.
- The circuit breaker opens when a scanner does not answer, not when the guard answers that it cannot scan a text.
- A file that failed its check does not block sending: the message goes without it. A warning or error that shows after an early send cancels that send.
- Stop ends the reply like the composer's stop button: nothing is written in the model's name.
- In monitor mode nothing is stored on a tool step; the taint then only holds for the running reply.
- Error texts llmlynx writes itself (tool down, wrong arguments) are not scanned.
- Files made by code are scanned for injections when the model reads them, not when they are made: an injection only matters to the model, and scanning every large file a run makes would take minutes on the Pi. Only the part the model reads is scanned, so a large file can still be read.
- Each run of code gets a jail of its own (bubblewrap) in the `code` container: its own user, PID, network, IPC and UTS namespaces, an unprivileged user without capabilities, no environment, the system read-only, its chat's files in a tmpfs of fixed size, and its chat's packages read-only. The jail's network namespace is empty. The run's in and out folders reach the jail as open directories, not mounts, held by a process that cannot be inspected, so code cannot reach them. Limits: 120 seconds, 512 MB, one CPU core, 128 processes and threads, 1 MB of output.
- bubblewrap needs user namespaces and mounts inside them, which Docker's default seccomp profile only allows with `CAP_SYS_ADMIN`. `tools/code/seccomp_profile.json` is the browser's profile (Playwright's) plus `mount`, `umount2` and `pivot_root`; the kernel still allows them only inside the jail's own user namespace. On a host whose AppArmor profile forbids mounts, the container says at start that it cannot make a jail.
- The code container has no route out: it sits on an internal network with `code-egress` and clamd. `code-egress` (squid) passes the app's calls in, and lets installs reach `pypi.org`, `files.pythonhosted.org` and `registry.npmjs.org` over HTTPS, and nothing else. A port cannot be published from an internal network, hence the proxy in front.
- Installs run no package code: pip only takes wheels (`--only-binary=:all:`), resolves in a dry run against the image's own packages, and installs exactly the resolved wheels without their dependencies; npm only writes a lock, and llmlynx unpacks the tarballs itself, so install scripts never run. Every file must come from its index's host with the hash the index states. ClamAV scans inside the archives; only files that passed go into the shared cache, by their hash, so none is downloaded or scanned twice.
- HTML artifacts show in a frame with `sandbox="allow-scripts"` (an origin of its own: no cookies, no calls to the app) and a content policy that allows no loads, connections, forms or frames. The app's pages only let frames show the app's own pages (`frame-src 'self'`), so a script cannot navigate its frame to another site with data in the URL, and the frame route refuses to be opened as a page of its own (`Sec-Fetch-Dest`). WebRTC, which no content policy closes, is taken from the page before its scripts run. SVG only shows as an image, in which scripts do not run.
- A chat's packages are removed from the code container when the chat or the account is deleted, and after 30 days without use in any case; the next run installs them again from the chat's lock.
- git is only in `/opt/git` of the code container, which only the git tool's jails see: a run of code has no git binary and never sees a repository's `.git` folder. That folder is kept in the database (`SandboxRepo`), apart from the sandbox's files, and no tool can store a file in a `.git` folder of the sandbox.
- git cannot run other programs: the git tool takes a list of commands, without the options that run a program or write outside the repository (`--exec`, `--upload-pack`, `--ext-diff`, `--output` outside the work tree, `-c`, and others), and git config only sets `user.name` and `user.email`. Hooks, fsmonitor, editors, pagers and credential helpers are off by settings on git's command line, which a repository's config cannot change. Before and after each command, the repository's config may only hold the keys git writes itself for these commands, and nothing in `.git` may point outside it; otherwise nothing is kept.
- The model's git command always runs in a jail without network. clone, fetch and pull first download a bare copy of the remote in another jail, with network but with nothing of the chat in it, and with a command built from the URL and the options that say what to download; the model's command then runs against that copy. That jail's git only speaks HTTPS, and only reaches `code-egress`'s git port, which refuses private, loopback and LAN addresses. Downloads stop at 80 MB or 3 minutes, and objects from the internet are checked by git (`transfer.fsckObjects`). Nothing can be pushed: the sandbox has no credentials.

## Known limits

- A classifier can be bypassed by an attack that adapts to it.
- Attached files are not scanned for injections: a document the user got from someone else can carry instructions aimed at the model.
- Images are not scanned for injections: text in a screenshot, photo or scanned PDF page reaches a model that can see.
- Virus signatures only catch known malware.
- The web tools hand the app text and screenshots, never downloaded files, so a virus hit on internet content will be rare.
- A tainted conversation stays tainted: code runs in it only after the user agrees. Start a new conversation to get rid of the taint.
- No URL is checked before a tool opens it (decided on 2026-11-16: the rule that a URL must come from the user or a tool result blocked too many good downloads). A model that injected text talked into it can put conversation data in a URL it opens, or in a search query; the injection scan is the only guard against that.
- The 22m model is trained on English; use 86m for other languages if the server is fast enough.
- A paused reply keeps its connection open for up to 10 minutes; a network that cuts idle connections counts as Stop.
- The injection guard can be fooled by an attack made to get past it. For the sandbox, the real boundary is the jail without network.
- Code can make an HTML page that looks misleading. It cannot send anything anywhere, but the user may still believe it.
- Python packages without a wheel for the Pi, npm packages that need an install script, and system packages cannot be installed.
- A git URL can carry conversation data out, like any URL a tool opens (see above). Only public repositories can be cloned, and only over HTTPS.
- Files git checks out are scanned for viruses, but a repository's history is not: a virus in an old commit is found when it is checked out.
- A malicious package is caught by the virus scanner only when it is known malware. The jail without network is what keeps it in its chat: at most it spoils that chat's own files and results.
- A download's whole text is scanned within 3 minutes: a large text file (several MB on the Pi; a 9 MB CSV on the dev machine) cannot be checked in time, and is then not stored.
- A run's memory limit is enforced by watching it every 0.1 seconds; the container's limit stops what grows faster than that.

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

**Memory on the Pi (8 GB).** clamd holds about 1 GB of signatures (962 MB measured); `ConcurrentDatabaseReload no` keeps an update from doubling that. The guard takes about 1 GB with `22m`. Both have a limit of 2 GB. Next to them run the browser (limit 1.5 GB), files (limit 1.5 GB) and code (limit 1.5 GB) containers, which only use memory while they work.

**Runs and installs.** On the server: `docker compose exec code /opt/server/venv/bin/python /opt/server/bench.py`. Dev-machine numbers (the same Ryzen), next to the guard, ClamAV and the browser: a run of Python, JavaScript, TypeScript or a shell command 0.14 to 0.19 s, a pandas and matplotlib chart 1.1 s; an install from PyPI 3.5 s (most of it resolving), from npm 7.3 s the first time and 0.55 s from the cache; a download of a small CSV about 1 s with its scans. Two runs or installs run at once (`CODE_MAX_CONCURRENCY`).
