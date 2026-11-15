# @jangmanj/pi-hashline

`oh-my-pi`'s native Rust `hashline` edit engine (`@oh-my-pi/pi-natives` N-API addon, MIT) packaged as a Pi extension, with a user-editable routing config (`~/.pi/agent/hashline.json`) and a fast deterministic calibrator (`calibrate.mjs`).

Instead of echoing `oldText` and matching whitespace, `read` prefixes text files with a 4-hex snapshot header (`[path#TAG]`) and `LINE:TEXT` numbers, and `hashline_edit` applies line-span (`PUT N.=M:`), syntax-block (`PUT N*:`), gap-insert (`PUT <N:`, `PUT >N:`, `PUT >$:`), register cut/paste (`CUT ... @name`), move (`MV`), and delete (`REM`) patches directly in Rust.

## Configuration (`~/.pi/agent/hashline.json`)

Created automatically on first load (override path with `PI_HASHLINE_CONFIG`). `use` / `defaultUse` accept `"hashline"` or `"built-in"` (legacy `"replace"` is read as `"built-in"`). Routing precedence:

1. **Manual selection** (`"manual": true` in `rules`, toggled with `Enter` in `/hashline`)
2. **Benchmark verdict** (`calibrated["provider/model"]`, written by `Ctrl+B` or `calibrate.mjs`)
3. **Default family rules** (`rules`, longest match wins, e.g. `*gemini*`, `openai-codex/*`, `anthropic/*`, `kimi*`)
4. **`defaultUse`** (`"built-in"` or `"hashline"`)

## Picker (`/hashline`, Alt+H)

`/hashline` (no arguments) and Alt+H open the routing and benchmark picker (rebind with `"pi-hashline": { "shortcut": ... }` in `settings.json`; `false` disables it). Tabs: **Frequent** (current, favorite, previously used, benchmarked, or manually overridden models), **Benchmarked**, **All**, then one tab per provider.

Columns: **Model** (`●` green = hashline, dim = built-in, gold = running benchmark), **Provider** (cross-provider tabs only), **Bench** (measured median edit speedup such as `2.00×`; blank until benchmarked), **Saved** (output edit-payload byte savings such as `-79%`; blank until benchmarked), **Edit** (`● hashline` / `○ built-in`), **Recommended** (`✓ hashline`, `✓ built-in`, `✗ failed`, `—`, or a live Nerd Font gauge ` ███░░░ 4/8`). The bottom right shows the average measured cost of past benchmarks (`bench: ~8 calls · ~58k tok (avg of 3)`), a fallback estimate (`~8 calls · ~60k tok (est.)`) when none is recorded, and live calls/tokens while a benchmark runs.

Keys: `Enter` switch edit tool · `Ctrl+R` (or `Ctrl+X`) reset model (clears manual override & benchmark) · `Ctrl+B` run/stop benchmark · `Ctrl+S` cycle `▲` then `▼` across visible columns left to right (Model, Provider, Bench, Saved, Edit, Recommended, plus tab default when distinct) · `Tab`/`Shift+Tab` or `←`/`→` tabs · type to search · `Esc` close.

## Deterministic Calibrator (`calibrate.mjs`)

Runs pre-seeded 1-turn multi-hunk refactoring micro-tasks in-process via `ModelRuntime.streamSimple()` (zero subprocess cold starts, no wasted `read` / `"done"` turns, HTTP 429/5xx retry backoffs excluded from `editMs`, and alternating arm order across `--repeats 2` / `benchRepeats` with median scoring). Benchmarks never auto-abort when exceeding estimated calls, tokens, or time unless `"stopOnOverrun": true` (optional `maxBenchCalls`, `maxBenchTokens`, `benchTimeoutSec`) is enabled in `hashline.json` or `--stop-on-overrun` is passed:
```sh
# Calibrate default roster across major provider families
node calibrate.mjs

# Calibrate specific models (or increase repeats for tighter medians)
node calibrate.mjs openai-codex/gpt-6-astra kimi-coding/k3.1-pro-highspeed
node calibrate.mjs --repeats 3 --thinking high --min-speedup 1.15 --dry-run
```

## Verify & benchmark

```sh
node test.mjs
node bench-ab.mjs antigravity/gemini-4-carbon high
node bench-ab.mjs openai-codex/gpt-6-astra high
```
