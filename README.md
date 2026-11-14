# pi-hashline

`oh-my-pi`'s native Rust `hashline` edit engine (`@oh-my-pi/pi-natives` N-API addon, MIT) packaged as a Pi extension.

Instead of echoing `oldText` and matching whitespace, `read` prefixes text files with a 4-hex snapshot header (`[path#TAG]`) and `LINE:TEXT` numbers, and `hashline_edit` applies line-span (`PUT N.=M:`), syntax-block (`PUT N*:`), gap-insert (`PUT <N:`, `PUT >N:`, `PUT >$:`), register cut/paste (`CUT ... @name`), move (`MV`), and delete (`REM`) patches directly in Rust.

## Mode routing (`PI_HASHLINE` or `/hashline`)

- `auto` (default): swaps `edit` -> `hashline_edit` on Gemini (`google/*`, `google-vertex/*`, `antigravity/gemini-*`) and OpenAI (`openai/*`, `openai-codex/*`, excluding `spark`), keeping stock `edit(oldText, newText)` on Claude, Kimi, DeepSeek, MiniMax, and Qwen.
- `all`: enables `hashline_edit` on Claude as well.
- `force`: enables `hashline_edit` on every model.
- `off`: disables `hashline_edit` everywhere.

Call telemetry is appended to `~/.pi/agent/hashline-stats.jsonl` (`/hashline stats`).

## Verify & benchmark

```sh
node test.mjs
node bench-ab.mjs antigravity/gemini-4-carbon high
node bench-ab.mjs openai-codex/gpt-6-astra high
```
