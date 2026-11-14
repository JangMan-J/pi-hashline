# pi-hashline

`oh-my-pi`'s native Rust `hashline` edit engine (`@oh-my-pi/pi-natives` N-API addon, MIT) packaged as a Pi extension, with a user-editable routing config (`~/.pi/agent/hashline.json`) and a fast deterministic calibrator (`calibrate.mjs`).

Instead of echoing `oldText` and matching whitespace, `read` prefixes text files with a 4-hex snapshot header (`[path#TAG]`) and `LINE:TEXT` numbers, and `hashline_edit` applies line-span (`PUT N.=M:`), syntax-block (`PUT N*:`), gap-insert (`PUT <N:`, `PUT >N:`, `PUT >$:`), register cut/paste (`CUT ... @name`), move (`MV`), and delete (`REM`) patches directly in Rust.

## Configuration (`~/.pi/agent/hashline.json`)

Created automatically on first load (override path with `PI_HASHLINE_CONFIG`). Routing precedence in `auto` mode:

1. **Pinned rules** (`"pinned": true` in `rules` — hand-edited or set via `/hashline pin <hashline|replace> [glob]`)
2. **Calibrated results** (`calibrated["provider/model"]` written by `calibrate.mjs`)
3. **Family/model glob rules** (`rules`, longest match wins, e.g. `*gemini*`, `openai-codex/*`, `anthropic/*`, `kimi*`)
4. **`defaultUse`** (`"replace"` or `"hashline"`)

Runtime overrides (`PI_HASHLINE` env var or `/hashline` command):
- `/hashline` — show active decision and rule/calibration source for the current model
- `/hashline pin <hashline|replace> [provider/model-glob]` — pin a model or family in `hashline.json`
- `/hashline auto | all | force | off` — switch session override mode
- `/hashline stats` — summarize recorded calls from `~/.pi/agent/hashline-stats.jsonl`

## Picker (`/hashline` menu, Alt+H)

Columns: **Model** (`●` green = hashline, dim = replace/off, gold = pinned/running), **Provider** (cross-provider tabs only), **Uses** (session count, `★` = pi-picks favorite), **Edit** (`● hashline` / `○ replace`, `*` = pinned), **Bench** (`✓ faster`, `✓ keep replace`, `✗ error`, `untested`). A fixed header row shows the active sort; column positions never shift while scrolling, toggling, or sorting, and narrow terminals drop Uses, then Bench, then Edit.

Keys: `Enter` swap edit tool (pins the model) · `Ctrl+S` cycle sort (default → Uses → Edit → Bench → Model → Provider) · `Ctrl+B` run/stop benchmark · `Ctrl+U` unpin · `Ctrl+O` cycle mode (auto → all → force → off; `Ctrl+G` is left to Zellij) · `Tab` tabs · `Esc` close.

## Deterministic Calibrator (`calibrate.mjs`)

Runs two bash-free, 2-turn (`read` -> `edit`) multi-hunk refactoring micro-tasks head-to-head (`replace` vs `hashline`, starting both arms simultaneously per task and verifying output with strict Node assertions in `<20 ms`), then writes each model's verdict (plus raw timing/byte fields, which the picker summarizes only as faster / keep replace) into `~/.pi/agent/hashline.json`:

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
