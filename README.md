# @jangmanj/pi-hashline

`oh-my-pi`'s native Rust `hashline` edit engine (`@oh-my-pi/pi-natives` N-API addon, MIT) packaged as a Pi extension, with a user-editable routing config (`~/.pi/agent/hashline.json`) and a picker that shows what hashline would change for each model, replayed from your own sessions with no model calls.

Instead of echoing `oldText` and matching whitespace, `read` prefixes text files with a 4-hex snapshot header (`[path#TAG]`) and `LINE:TEXT` numbers, and `hashline_edit` applies line-span (`PUT N.=M:`), syntax-block (`PUT N*:`), gap-insert (`PUT <N:`, `PUT >N:`, `PUT >$:`), register cut/paste (`CUT ... @name`), move (`MV`), and delete (`REM`) patches directly in Rust.

## Configuration (`~/.pi/agent/hashline.json`)

Created automatically on first load (override path with `PI_HASHLINE_CONFIG`). Installing the extension changes nothing: every model stays on Pi's built-in edit tool until you switch it. `use` / `defaultUse` accept `"hashline"` or `"built-in"` (legacy `"replace"` is read as `"built-in"`). Routing precedence:

1. **Manual selection** (`"manual": true` in `rules`, toggled with `Enter` in `/hashline`)
2. **Rules you write by hand** (`rules`, longest match wins, e.g. `{ "match": "*gemini*", "use": "hashline" }`)
3. **`defaultUse`** (`"built-in"` unless you change it)

Earlier versions seeded every new file with family rules that moved whole model families to hashline, and stored benchmark results. Those seeded rules and the benchmark keys (`calibrated`, `minSpeedup`, `benchRepeats`, …) are ignored and removed the next time the file is saved; your manual selections and any rule you wrote differently are kept.

## Picker (`/hashline`, Alt+H)

`/hashline` (no arguments) and Alt+H open the routing picker (rebind with `"pi-hashline": { "shortcut": ... }` in `settings.json`; `false` disables it). Tabs: **Frequent** (current, favorite, previously used, or manually overridden models), **All**, then one tab per provider.

Columns: **Model** (a `●` marks only the active model, in green, and favorites, in gold, as in pi-picks), **Provider** (cross-provider tabs only), **Speed** and **Cost** (what hashline would have changed for that model, replayed from your own sessions; see below), **Edit** (`● hashline` / `○ built-in`). The header shows how many models have replayed figures.

Keys: `Enter` switch edit tool · `Ctrl+D` floating detail pane for the selected model (any key closes it) · `Ctrl+R` clear the manual override · `Ctrl+X` clear every manual override in the current tab · `Ctrl+S` cycle `▲` then `▼` across visible columns left to right (Model, Provider, Speed, Cost, Edit, plus tab default when distinct) · `Tab`/`Shift+Tab` or `←`/`→` tabs · type to search · `Esc` close.

## Transcript replay (`replay.ts`)

Speed and Cost need no model calls. Opening the picker scans your Pi sessions (`~/.pi/agent/sessions`, cached per file in `hashline-replay-cache.json`) and writes one row per model to `~/.pi/agent/hashline-replay.json`.

- **What is read:** the patch every built-in `edit` applied, the text every `read` returned, and the token usage, cost, cache reads, response duration and compaction points Pi recorded for each response.
- **What is computed:** the hashline call that makes the same change as each recorded patch, the line-number prefixes hashline would add to each read, and the larger result a hashline edit returns. Bytes are converted to tokens with each model's own bytes-per-token, measured on its recorded responses.
- **Speed** is the share of the model's response time saved: output tokens no longer written, divided by the model's measured tokens per second.
- **Cost** is the change in the model's recorded spend, as a share of that spend: negative is cheaper. Output saved on edits lowers it; input added to reads and edit results raises it, once at the fresh-input price and again at the cached price on every later response until a compaction drops it. Prices are the ones Pi recorded for that model.
- Green means hashline is better (a positive Speed, a negative Cost); red means worse. A figure is coloured only once it is settled: your sessions are redrawn with replacement 200 times, and the figure must stay on the same side of zero in 95% of the draws. Until then it is dimmed and gives no verdict, and the bottom line says `N edits replayed so far; figures settle as you work`. Nothing settles on fewer than 30 replayed edits or 5 sessions. Each figure is judged on its own sample: Speed counts only edits from responses with a recorded duration, so a model can have a settled Cost and a dimmed or blank Speed. The detail pane shows how many edits were replayed.
- Speed and Cost are never combined into one verdict. Sort by Speed (`Ctrl+S`) and the **Edit** column turns green where the model's current tool is the faster one and red where it is not; sort by Cost and it is judged on cost instead. Under any other sort it shows plain hashline / built-in colours.

The detail pane (`Ctrl+D`) floats over the list with one fact per line: Speed with seconds saved per edit, Cost against what was spent, the share of built-in edits that failed, and the share of real hashline calls that failed once your sessions contain any. The full breakdown behind each figure is in `~/.pi/agent/hashline-replay.json`.

There is no separate benchmark. A model's own use is the test: switch it with `Enter`, keep working, and the Hashline line fills in with how often its real calls failed.

### Importing sessions from elsewhere

Sessions on another machine or in an archive can be added without copying them into Pi. `scripts/build-replay-seed.ts` scans any Pi session directories and writes their per-model sums (counts and byte totals only, no file contents) to a seed file; place it at `~/.pi/agent/hashline-replay-seed.json` and every replay adds it to the local sessions. A session file name is counted once.

```sh
node scripts/build-replay-seed.ts --out seed.json --skip-names names-already-on-target.txt "laptop=~/.pi/agent/sessions" "archive=/backup/.pi/agent/sessions"
```

Sessions recorded before Pi stored response durations add to Cost and failure counts but not to Speed.

Limits: the replay assumes the model writes the minimal hashline patch; how often a model gets hashline wrong only shows up in the Hashline line of the detail pane, after it has made real hashline calls. Edits made through `codemode` record no patch, so totals are scaled up from the direct edits and reads.

## Verify

```sh
npm run check
```
