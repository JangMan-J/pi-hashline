# pi-hashline

`oh-my-pi`'s native Rust `hashline` edit engine (`@oh-my-pi/pi-natives` N-API addon, MIT) packaged as a Pi extension, with a user-editable routing config (`~/.pi/agent/hashline.json`) and a fast deterministic calibrator (`calibrate.mjs`).

Instead of echoing `oldText` and matching whitespace, `read` prefixes text files with a 4-hex snapshot header (`[path#TAG]`) and `LINE:TEXT` numbers, and `hashline_edit` applies line-span (`PUT N.=M:`), syntax-block (`PUT N*:`), gap-insert (`PUT <N:`, `PUT >N:`, `PUT >$:`), register cut/paste (`CUT ... @name`), move (`MV`), and delete (`REM`) patches directly in Rust.

## Configuration (`~/.pi/agent/hashline.json`)

Created automatically on first load (override path with `PI_HASHLINE_CONFIG`). `use` / `defaultUse` accept `"hashline"` or `"built-in"` (legacy `"replace"` is read as `"built-in"`). Routing precedence in `auto` mode:

1. **Pinned rules** (`"pinned": true` in `rules`, hand-edited or set with `Enter` in the picker)
2. **Calibrated results** (`calibrated["provider/model"]`, written by `calibrate.mjs` or `Ctrl+B` in the picker)
3. **Family/model glob rules** (`rules`, longest match wins, e.g. `*gemini*`, `openai-codex/*`, `anthropic/*`, `kimi*`)
4. **`defaultUse`** (`"built-in"` or `"hashline"`)

The session mode starts from `PI_HASHLINE` (`auto` default, `all`, `force`, `off`) and is cycled in the picker.

## Picker (`/hashline`, Alt+H)

`/hashline` (no arguments) and Alt+H open the routing and benchmark picker (rebind with `"pi-hashline": { "shortcut": ... }` in `settings.json`; `false` disables it). Tabs: **Frequent** (current, favorite, previously used, benchmarked or pinned models), **Benchmarked**, **All**, then one tab per provider.

Columns: **Model** (`●` green = hashline, dim = built-in/off, gold = pinned/running), **Provider** (cross-provider tabs only), **Speed** (measured edit speedup such as `2.00×`; blank until benchmarked), **Edit** (`● hashline` / `○ built-in`, `*` = pinned), **Bench** (`✓ hashline`, `✓ built-in`, `✗ failed`, `—`, or a live Nerd Font gauge ` ███░░░ 4/8`). The bottom right shows the average measured cost of past benchmarks (`bench: ~10 calls · ~35k tok (avg of 3)`), a labelled estimate when none is recorded, and live calls/tokens while a benchmark runs.

Keys: `Enter` switch edit tool (pins the model) · `Ctrl+B` run/stop benchmark · `Ctrl+U` unpin · `Ctrl+O` cycle mode (auto → all → force → off; `Ctrl+G` is left to Zellij) · `Ctrl+S` cycle sort (default → Speed → Edit → Bench → Model → Provider) · `Tab`/`Shift+Tab` or `←`/`→` tabs · type to search · `Esc` close.

## Deterministic Calibrator (`calibrate.mjs`)

Runs two bash-free, 2-turn (`read` -> `edit`) multi-hunk refactoring micro-tasks head-to-head (`built-in` vs `hashline`, starting both arms simultaneously per task and verifying output with strict Node assertions in `<20 ms`), then writes each model's measured speed ratio, API calls, token usage, and routing verdict into `~/.pi/agent/hashline.json`:

```sh
# Calibrate default roster across major provider families (~45-90s total)
node calibrate.mjs

# Calibrate specific models or preview without writing hashline.json
node calibrate.mjs openai-codex/gpt-6-astra kimi-coding/k3.1-pro-highspeed
node calibrate.mjs --thinking high --min-speedup 1.15 --dry-run
```

## Verify & benchmark

```sh
node test.mjs
node bench-ab.mjs antigravity/gemini-4-carbon high
node bench-ab.mjs openai-codex/gpt-6-astra high
```
