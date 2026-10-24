# Skill Creator

A skill for creating new skills and iteratively improving them.

## runtime output rules

When running inside the canvas, help the user create or update the skill without exposing runtime implementation details.

- In the canvas, the worker-owned `_save_user_skill` tool is the only commit path for a user Skill. Draft and validate `SKILL.md` plus any Markdown reference files, then call that tool with the canonical name, description, instructions, files, and a newly generated stable `operation_id`. Do not use `Write` or `Bash` to commit a Skill directly into a home directory.
- Treat the tool response as the commit result: only tell the user the Skill was created or updated after the tool returns success. If it returns an error, explain that the save did not complete and do not claim the Skill exists.
- For retries of the same create/update operation, reuse the same `operation_id`; do not generate a new one after a timeout or lost response. For updating an existing Skill, provide the latest `base_version` when available so the worker can reject stale edits instead of overwriting newer API changes.
- Outside, use the normal filesystem workflow and follow the destination rules below. If the worker-owned tool is unavailable inside the canvas, do not write a fallback copy or claim persistence; keep the draft and ask the user to retry.
- Treat skill destinations as scoped: the user-owned area is distinct from project/runtime-scoped skills. Default to the user-owned area unless the user explicitly asks for a project-local skill or an evaluation workspace.
- When the filesystem workflow is used, resolve the user-owned skill root from the current runtime home; never pass a literal or relative `.claude/skills/...` path to a write operation.
- When the filesystem workflow is used, create the canonical directory form `<skill-root>/<skill-name>/SKILL.md` and do not create workspace-level `.skills/...`, `./...`, or other staging/cache-style locations.
- When the filesystem workflow is used, verify that `SKILL.md` exists under the resolved user-owned skill root. If you discover a mistaken project-local directory, remove only the directory you just created; do not delete pre-existing project/runtime skill directories.
- Do not mention installation paths, home directories, hidden runtime folders, or internal storage locations in user-visible replies.
- Do not print `.claude`, `agent-assets`, `agent-worker`, `sessions/workspace`, or NFS-style paths in user-visible replies.
- It is OK to describe the public artifact as `SKILL.md` when showing the file content the user asked for.
- Before creating a skill, choose one canonical skill name. It must be 1-64 characters and match `^[a-z0-9-]+$`: lowercase English letters, digits, and single hyphens only. Do not use spaces, underscores, uppercase letters, Chinese characters, or other special characters.
- If the user's requested title is not a valid skill name, convert it to a short English kebab-case slug before writing files. For example, `Ethan_prefer` becomes `ethan-prefer`, and `记忆代笔师` becomes a concise English slug such as `memory-ghostwriter`.
- Use the same canonical name for both the skill directory and the `name` field in `SKILL.md` frontmatter.
- If you successfully create or update a skill, reply with a concise success message and the skill name, e.g. "Created `<skill-name>`. You can try it now." Then list the files created or updated and briefly explain what each file covers. Do not include the destination path.
- Outside, if you cannot create files directly, provide the skill name and full `SKILL.md` content without discussing internal storage. Inside the canvas, a failed worker-owned commit is not a successful creation.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Choose the lightest useful structure: start with `SKILL.md`, add `references/` when the guidance needs progressive disclosure, and add scripts only for deterministic work that natural-language instructions cannot stabilize
- In the canvas, submit the complete draft through `_save_user_skill`; otherwise write the skill files directly when the environment permits it
- Tell the user the skill is created and ready to try, and summarize the files you created
- If the user wants more confidence, create a few realistic test prompts and review the outputs with them
- Use subagents, benchmark tooling, viewer pages, and description optimization only for higher-risk work, explicit evaluation requests, or cases where the skill needs evidence that it generalizes

Your job when using this skill is to figure out where the user is in this process and then jump in and help them progress through the next useful step. So for instance, maybe they're like "I want to make a skill for X". You can help narrow down what they mean, draft the skill, create the files, and suggest lightweight ways to sanity-check it.

On the other hand, maybe they already have a draft of the skill. In this case you can go straight to editing, simplifying, restructuring, or, if warranted, evaluating it.

Of course, you should always be flexible and if the user is like "I don't need to run a bunch of evaluations, just vibe with me", you can do that instead.

Then after the skill is done (but again, the order is flexible), you can offer description optimization or deeper evaluation. Treat those as advanced add-ons, not the default creation path.

## Communicating with the user

The skill creator is liable to be used by people across a wide range of familiarity with coding jargon. If you haven't heard (and how could you, it's only very recently that it started), there's a trend now where the power of Claude is inspiring plumbers to open up their terminals, parents and grandparents to google "how to install npm". On the other hand, the bulk of users are probably fairly computer-literate.

So please pay attention to context cues to understand how to phrase your communication! In the default case, just to give you some idea:

- "evaluation" and "benchmark" are borderline, but OK
- for "JSON" and "assertion" you want to see serious cues from the user that they know what those things are before using them without explaining them

It's OK to briefly explain terms if you're in doubt, and feel free to clarify terms with a short definition if you're unsure if the user will get it.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first — the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step.

1. What should this skill enable Claude to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Is a quick sanity check enough, or does this skill need a more formal evaluation? Most lightweight workflow or guidance skills only need a few realistic prompts for review. Skills with objectively verifiable outputs, high-risk behavior, or high-volume use may benefit from test cases.

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out.

Check available resources if useful for research (searching docs, finding similar skills, looking up best practices). Do this inline by default. Use subagents only when the research is large enough to benefit from independent parallel work; most skill creation requests do not need them.

### Write the SKILL.md

Based on the user interview, fill in these components:

- **name**: Canonical skill identifier. It must be 1-64 characters and use only lowercase English letters, digits, and hyphens (`^[a-z0-9-]+$`). Do not use spaces, underscores, uppercase letters, Chinese characters, or special characters. If the user gives a display title or non-English name, derive a concise English kebab-case identifier and use it consistently.
- **description**: When to trigger, what it does. This is the primary triggering mechanism - include both what the skill does AND specific contexts for when to use it. All "when to use" info goes here, not in the body. Note: currently Claude has a tendency to "undertrigger" skills -- to not use them when they'd be useful. To combat this, please make the skill descriptions a little bit "pushy". So for instance, instead of "How to build a simple fast dashboard to display internal Anthropic data.", you might write "How to build a simple fast dashboard to display internal Anthropic data. Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don't explicitly ask for a 'dashboard.'"
- **compatibility**: Required tools, dependencies (optional, rarely needed)
- **the rest of the skill:)**

Outside, create the files after drafting them when filesystem access is available. In the canvas, submit the draft through `_save_user_skill` instead of writing to a runtime home or skill directory. Never include an internal destination path in the user-facing success message.

### Semantic, tool-agnostic guidance

Skills should guide the agent by describing intent, workflow, decisions, inputs, outputs, quality bars, and failure handling. Avoid coupling a skill to current implementation details that may evolve:

- Do not encode current CLI commands, API routes, request parameters, environment variables, internal tokens, storage paths, or service names as the contract of the skill.
- If the skill needs files, canvas state, generated media, search, retrieval, or other runtime capabilities, describe the capability semantically, e.g. "use the available file inspection capability" or "use the available canvas-reading capability."
- Mention a specific tool or command only when the user explicitly asks for a tool-specific skill, the tool is itself the subject matter, or deterministic use of that exact interface is essential.
- Prefer stable decision rules over operational recipes that mirror today's runtime wiring.

### Default file structure

Use the smallest structure that gives the future agent enough guidance:

1. `SKILL.md` (required) - trigger metadata and concise operating instructions.
2. `references/` (preferred optional extension) - detailed domain rules, examples, schemas, style guides, or long workflows that should be loaded only when needed.
3. `assets/` (optional) - templates, images, sample files, or other resources used in outputs.
4. `scripts/` (exceptional) - deterministic helpers for repeated, fragile, or error-prone operations that natural-language instructions cannot make reliable.
5. `agents/`, benchmark workspaces, viewer outputs, and eval tooling (advanced) - use for rigorous validation, not ordinary skill creation.

Most skills should be `SKILL.md` plus, at most, a few focused reference files. Do not create scripts just because a task has steps; create scripts only when determinism or repetition justifies maintaining code.

### Skill Writing Guide

#### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── references/ - Docs loaded into context as needed
    ├── assets/     - Files used in output (templates, icons, fonts)
    └── scripts/    - Exceptional helpers for deterministic/repetitive tasks
```

#### Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)

These word counts are approximate and you can feel free to go longer if needed.

**Key patterns:**
- Keep SKILL.md under 500 lines; if you're approaching this limit, add an additional layer of hierarchy along with clear pointers about where the model using the skill should go next to follow up.
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents
- Prefer reference files over scripts when the added material is guidance, examples, rules, schemas, or domain knowledge.
- Prefer no bundled resources when the skill can stay clear and concise in one `SKILL.md`.

**Domain organization**: When a skill supports multiple domains/frameworks, organize by variant:
```
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```
Claude reads only the relevant reference file.

#### Principle of Lack of Surprise

This goes without saying, but skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. Things like a "roleplay as an XYZ" are OK though.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats** - You can do it like this:
```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern** - It's useful to include examples. You can format them like this (but if "Input" and "Output" are in the examples you might want to deviate a little):
```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing Style

Try to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Start by writing a draft and then look at it with fresh eyes and improve it.

### Test Cases

After writing the skill draft, consider 2-3 realistic test prompts — the kind of thing a real user would actually say. For ordinary skill creation, this can be a quick conversational sanity check rather than a full benchmark. Share them with the user: [you don't have to use this exact language] "Here are a few test cases I'd use to sanity-check this. Do these look right, or do you want to add more?"

Only run the full eval workflow below when the user explicitly asks for evaluation, the skill affects high-risk or high-volume work, or you have reason to believe the skill may not generalize without evidence.

Save test cases to `evals/evals.json`. Don't write assertions yet — just the prompts. You'll draft assertions in the next step while the runs are in progress.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

See `references/schemas.md` for the full schema (including the `assertions` field, which you'll add later).

## Running and evaluating test cases

This is an advanced validation workflow. Do not make it the default path for ordinary skill creation. Use it when the user asks for testing/benchmarks, the skill is high-risk, or the user needs evidence that the skill improves behavior.

Once you choose to run this workflow, treat this section as one continuous sequence — don't stop partway through. Do NOT use `/skill-test` or any other testing skill.

Put results in `<skill-name>-workspace/` as a sibling to the skill directory. Within the workspace, organize results by iteration (`iteration-1/`, `iteration-2/`, etc.) and within that, each test case gets a directory (`eval-0/`, `eval-1/`, etc.). Don't create all of this upfront — just create directories as you go.

### Step 1: Spawn all runs (with-skill AND baseline) in the same turn

For each test case, spawn two subagents in the same turn — one with the skill, one without. This is important: don't spawn the with-skill runs first and then come back for baselines later. Launch everything at once so it all finishes around the same time.

**With-skill run:**

```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
```

**Baseline run** (same prompt, but the baseline depends on context):
- **Creating a new skill**: no skill at all. Same prompt, no skill path, save to `without_skill/outputs/`.
- **Improving an existing skill**: the old version. Before editing, snapshot the skill (`cp -r <skill-path> <workspace>/skill-snapshot/`), then point the baseline subagent at the snapshot. Save to `old_skill/outputs/`.

Write an `eval_metadata.json` for each test case (assertions can be empty for now). Give each eval a descriptive name based on what it's testing — not just "eval-0". Use this name for the directory too. If this iteration uses new or modified eval prompts, create these files for each new eval directory — don't assume they carry over from previous iterations.

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

### Step 2: While runs are in progress, draft assertions

Don't just wait for the runs to finish — you can use this time productively. Draft quantitative assertions for each test case and explain them to the user. If assertions already exist in `evals/evals.json`, review them and explain what they check.

Good assertions are objectively verifiable and have descriptive names — they should read clearly in the benchmark viewer so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Update the `eval_metadata.json` files and `evals/evals.json` with the assertions once drafted. Also explain to the user what they'll see in the viewer — both the qualitative outputs and the quantitative benchmark.

### Step 3: As runs complete, capture timing data

When each subagent task completes, you receive a notification containing `total_tokens` and `duration_ms`. Save this data immediately to `timing.json` in the run directory:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

This is the only opportunity to capture this data — it comes through the task notification and isn't persisted elsewhere. Process each notification as it arrives rather than trying to batch them.

### Step 4: Grade, aggregate, and launch the viewer

Once all runs are done:

1. **Grade each run** — spawn a grader subagent (or grade inline) that reads `agents/grader.md` and evaluates each assertion against the outputs. Save results to `grading.json` in each run directory. The grading.json expectations array must use the fields `text`, `passed`, and `evidence` (not `name`/`met`/`details` or other variants) — the viewer depends on these exact field names. For assertions that can be checked programmatically, write and run a script rather than eyeballing it — scripts are faster, more reliable, and can be reused across iterations.

2. **Aggregate into benchmark** — run the aggregation script from the skill-creator directory:
   ```bash
   python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
   ```
 This produces `benchmark.json` and `benchmark.md` with pass_rate, time, and tokens for each configuration, with mean ± stddev and the delta. If generating benchmark.json manually, see `references/schemas.md` for the exact schema the viewer expects.
Put each with_skill version before its baseline counterpart.

3. **Do an analyst pass** — read the benchmark data and surface patterns the aggregate stats might hide. See `agents/analyzer.md` (the "Analyzing Benchmark Results" section) for what to look for — things like assertions that always pass regardless of skill (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs.

4. **Launch the viewer** with both qualitative outputs and quantitative data:
   ```bash
   nohup python <skill-creator-path>/eval-viewer/generate_review.py \
     <workspace>/iteration-N \
     --skill-name "my-skill" \
     --benchmark <workspace>/iteration-N/benchmark.json \
     > /dev/null 2>&1 &
   VIEWER_PID=$!
   ```
 For iteration 2+, also pass `--previous-workspace <workspace>/iteration-<N-1>`.

 **Cowork / headless environments:** If `webbrowser.open()` is not available or the environment has no display, use `--static <output_path>` to write a standalone HTML file instead of starting a server. Feedback will be downloaded as a `feedback.json` file when the user clicks "Submit All Reviews". After download, copy `feedback.json` into the workspace directory for the next iteration to pick up.

Note: please use generate_review.py to create the viewer; there's no need to write custom HTML.

5. **Tell the user** something like: "I've opened the results in your browser. There are two tabs — 'Outputs' lets you click through each test case and leave feedback, 'Benchmark' shows the quantitative comparison. When you're done, come back here and let me know."

### What the user sees in the viewer

The "Outputs" tab shows one test case at a time:
- **Prompt**: the task that was given
- **Output**: the files the skill produced, rendered inline where possible
- **Previous Output** (iteration 2+): collapsed section showing last iteration's output
- **Formal Grades** (if grading was run): collapsed section showing assertion pass/fail
- **Feedback**: a textbox that auto-saves as they type
- **Previous Feedback** (iteration 2+): their comments from last time, shown below the textbox

The "Benchmark" tab shows the stats summary: pass rates, timing, and token usage for each configuration, with per-eval breakdowns and analyst observations.

Navigation is via prev/next buttons or arrow keys. When done, they click "Submit All Reviews" which saves all feedback to `feedback.json`.

### Step 5: Read the feedback

When the user tells you they're done, read `feedback.json`:

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

Empty feedback means the user thought it was fine. Focus your improvements on the test cases where the user had specific complaints.

Kill the viewer server when you're done with it:

```bash
kill $VIEWER_PID 2>/dev/null
```

---

## Improving the skill

This is the heart of the loop. You've run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.

### How to think about improvements

1. **Generalize from the feedback.** The big picture thing that's happening here is that we're trying to create skills that can be used a million times (maybe literally, maybe even more who knows) across many different prompts. Here you and the user are iterating on only a few examples over and over again because it helps move faster. The user knows these examples in and out and it's quick for them to assess new outputs. But if the skill you and the user are codeveloping works only for those examples, it's useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there's some stubborn issue, you might try branching out and using different metaphors, or recommending different patterns of working. It's relatively cheap to try and maybe you'll land on something great.

2. **Keep the prompt lean.** Remove things that aren't pulling their weight. Make sure to read the transcripts, not just the final outputs — if it looks like the skill is making the model waste a bunch of time doing things that are unproductive, you can try getting rid of the parts of the skill that are making it do that and seeing what happens.

3. **Explain the why.** Try hard to explain the **why** behind everything you're asking the model to do. Today's LLMs are *smart*. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the feedback from the user is terse or frustrated, try to actually understand the task and why the user is writing what they wrote, and what they actually wrote, and then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach.

4. **Prefer references before scripts.** If the test runs or user feedback show that the agent needs more domain knowledge, examples, or decision guidance, add or improve `references/` first. If multiple runs independently recreate the same fragile helper code, and natural-language guidance is not enough to stabilize it, then consider bundling a small script in `scripts/`.

This task is pretty important (we are trying to create billions a year in economic value here!) and your thinking time is not the blocker; take your time and really mull things over. I'd suggest writing a draft revision and then looking at it anew and making improvements. Really do your best to get into the head of the user and understand what they want and need.

### The iteration loop

After improving a skill in the advanced eval workflow:

1. Apply your improvements to the skill
2. Rerun all test cases into a new `iteration-<N+1>/` directory, including baseline runs. If you're creating a new skill, the baseline is always `without_skill` (no skill) — that stays the same across iterations. If you're improving an existing skill, use your judgment on what makes sense as the baseline: the original version the user came in with, or the previous iteration.
3. Launch the reviewer with `--previous-workspace` pointing at the previous iteration
4. Wait for the user to review and tell you they're done
5. Read the new feedback, improve again, repeat

Keep going until:
- The user says they're happy
- The feedback is all empty (everything looks good)
- You're not making meaningful progress

---

## Advanced: Blind comparison

For situations where you want a more rigorous comparison between two versions of a skill (e.g., the user asks "is the new version actually better?"), there's a blind comparison system. Read `agents/comparator.md` and `agents/analyzer.md` for the details. The basic idea is: give two outputs to an independent agent without telling it which is which, and let it judge quality. Then analyze why the winner won.

This is optional, requires subagents, and most users won't need it. The human review loop is usually sufficient.

---

## Description Optimization

The description field in SKILL.md frontmatter is the primary mechanism that determines whether Claude invokes a skill. Description optimization is optional. Use it when the user asks for trigger tuning, when the skill competes with nearby skills, or when lightweight sanity checks show obvious under-triggering or false-triggering. Do not run this by default for ordinary skill creation.

### Step 1: Generate trigger eval queries

Create 20 eval queries — a mix of should-trigger and should-not-trigger. Save as JSON:

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

The queries must be realistic and something a Claude Code or Claude.ai user would actually type. Not abstract requests, but requests that are concrete and specific and have a good amount of detail. For instance, file paths, personal context about the user's job or situation, column names and values, company names, URLs. A little bit of backstory. Some might be in lowercase or contain abbreviations or typos or casual speech. Use a mix of different lengths, and focus on edge cases rather than making them clear-cut (the user will get a chance to sign off on them).

Bad: `"Format this data"`, `"Extract text from PDF"`, `"Create a chart"`

Good: `"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`

For the **should-trigger** queries (8-10), think about coverage. You want different phrasings of the same intent — some formal, some casual. Include cases where the user doesn't explicitly name the skill or file type but clearly needs it. Throw in some uncommon use cases and cases where this skill competes with another but should win.

For the **should-not-trigger** queries (8-10), the most valuable ones are the near-misses — queries that share keywords or concepts with the skill but actually need something different. Think adjacent domains, ambiguous phrasing where a naive keyword match would trigger but shouldn't, and cases where the query touches on something the skill does but in a context where another tool is more appropriate.

The key thing to avoid: don't make should-not-trigger queries obviously irrelevant. "Write a fibonacci function" as a negative test for a PDF skill is too easy — it doesn't test anything. The negative cases should be genuinely tricky.

### Step 2: Review with user

Present the eval set to the user for review using the HTML template:

1. Read the template from `assets/eval_review.html`
2. Replace the placeholders:
 - `__EVAL_DATA_PLACEHOLDER__` → the JSON array of eval items (no quotes around it — it's a JS variable assignment)
 - `__SKILL_NAME_PLACEHOLDER__` → the skill's name
 - `__SKILL_DESCRIPTION_PLACEHOLDER__` → the skill's current description
3. Write to a temp file (e.g., `/tmp/eval_review_<skill-name>.html`) and open it: `open /tmp/eval_review_<skill-name>.html`
4. The user can edit queries, toggle should-trigger, add/remove entries, then click "Export Eval Set"
5. The file downloads to `~/Downloads/eval_set.json` — check the Downloads folder for the most recent version in case there are multiple (e.g., `eval_set (1).json`)

This step matters — bad eval queries lead to bad descriptions.

### Step 3: Run the optimization loop

Tell the user: "This will take some time — I'll run the optimization loop in the background and check on it periodically."

Save the eval set to the workspace, then run in the background:

```bash
python -m scripts.run_loop \
  --eval-set <path-to-trigger-eval.json> \
  --skill-path <path-to-skill> \
  --model <model-id-powering-this-session> \
  --max-iterations 5 \
  --verbose
```

Use the model ID from your system prompt (the one powering the current session) so the triggering test matches what the user actually experiences.

While it runs, periodically tail the output to give the user updates on which iteration it's on and what the scores look like.

This handles the full optimization loop automatically. It splits the eval set into 60% train and 40% held-out test, evaluates the current description (running each query 3 times to get a reliable trigger rate), then calls Claude to propose improvements based on what failed. It re-evaluates each new description on both train and test, iterating up to 5 times. When it's done, it opens an HTML report in the browser showing the results per iteration and returns JSON with `best_description` — selected by test score rather than train score to avoid overfitting.

### How skill triggering works

Understanding the triggering mechanism helps design better eval queries. Skills appear in Claude's `available_skills` list with their name + description, and Claude decides whether to consult a skill based on that description. The important thing to know is that Claude only consults skills for tasks it can't easily handle on its own — simple, one-step queries like "read this PDF" may not trigger a skill even if the description matches perfectly, because Claude can handle them directly with basic tools. Complex, multi-step, or specialized queries reliably trigger skills when the description matches.

This means your eval queries should be substantive enough that Claude would actually benefit from consulting a skill. Simple queries like "read file X" are poor test cases — they won't trigger skills regardless of description quality.

### Step 4: Apply the result

Take `best_description` from the JSON output and update the skill's SKILL.md frontmatter. Show the user before/after and report the scores.

---

### Package and Present (only outside or when explicitly requested)

In the canvas, the normal path is to submit the complete skill through `_save_user_skill` and tell the user it is ready to try only after the tool succeeds. Do not package by default.

Outside, or when the user explicitly asks for a distributable `.skill` file, check whether you have access to the `present_files` tool. If you don't, skip this step. If you do, package the skill and present the.skill file to the user:

```bash
python -m scripts.package_skill <path/to/skill-folder>
```

After packaging, direct the user to the resulting `.skill` file path so they can install it. Do not use this as the success path.

---

## Claude.ai-specific instructions

In Claude.ai, the core workflow is the same (draft → test → review → improve → repeat), but because Claude.ai doesn't have subagents, some mechanics change. Here's what to adapt:

**Running test cases**: No subagents means no parallel execution. For each test case, read the skill's SKILL.md, then follow its instructions to accomplish the test prompt yourself. Do them one at a time. This is less rigorous than independent subagents (you wrote the skill and you're also running it, so you have full context), but it's a useful sanity check — and the human review step compensates. Skip the baseline runs — just use the skill to complete the task as requested.

**Reviewing results**: If you can't open a browser (e.g., Claude.ai's VM has no display, or you're on a remote server), skip the browser reviewer entirely. Instead, present results directly in the conversation. For each test case, show the prompt and the output. If the output is a file the user needs to see (like a.docx or.xlsx), save it to the filesystem and tell them where it is so they can download and inspect it. Ask for feedback inline: "How does this look? Anything you'd change?"

**Benchmarking**: Skip the quantitative benchmarking — it relies on baseline comparisons which aren't meaningful without subagents. Focus on qualitative feedback from the user.

**The iteration loop**: Same as before — improve the skill, rerun the test cases, ask for feedback — just without the browser reviewer in the middle. You can still organize results into iteration directories on the filesystem if you have one.

**Description optimization**: This section requires the `claude` CLI tool (specifically `claude -p`) which is only available in Claude Code. Skip it if you're on Claude.ai.

**Blind comparison**: Requires subagents. Skip it.

**Packaging**: The `package_skill.py` script works anywhere with Python and a filesystem. On Claude.ai, you can run it and the user can download the resulting `.skill` file when they need a distributable package.

**Updating an existing skill**: The user might be asking you to update an existing skill, not create a new one. In this case:
- **Preserve the original name.** Note the skill's directory name and `name` frontmatter field -- use them unchanged. E.g., if the installed skill is `research-helper`, output `research-helper.skill` (not `research-helper-v2`).
- **Copy to a writeable location before editing.** The installed skill path may be read-only. Copy to `/tmp/skill-name/`, edit there, and package from the copy.
- **If packaging manually, stage in `/tmp/` first**, then copy to the output directory -- direct writes may fail due to permissions.

---

## Cowork-Specific Instructions

If you're in Cowork, the main things to know are:

- Most Cowork/ skill creation should still follow the lightweight path: create `SKILL.md`, add `references/` when useful, and tell the user the skill is ready to try.
- If you deliberately enter the advanced eval workflow, subagents are available, so spawning test cases in parallel, running baselines, and grading can work. If you run into severe problems with timeouts, it's OK to run the test prompts in series.
- You don't have a browser or display, so when generating the eval viewer during the advanced workflow, use `--static <output_path>` to write a standalone HTML file instead of starting a server. Then proffer a link that the user can click to open the HTML in their browser.
- Do not generate the eval viewer for ordinary skill creation. When you do choose the advanced workflow, use `generate_review.py` rather than writing custom HTML.
- Feedback works differently: since there's no running server, the viewer's "Submit All Reviews" button will download `feedback.json` as a file. You can then read it from there (you may have to request access first).
- Packaging works — `package_skill.py` just needs Python and a filesystem.
- Description optimization (`run_loop.py` / `run_eval.py`) should work in Cowork just fine since it uses `claude -p` via subprocess, not a browser, but please save it until you've fully finished making the skill and the user agrees it's in good shape.
- **Updating an existing skill**: The user might be asking you to update an existing skill, not create a new one. Follow the update guidance in the claude.ai section above.

---

## Reference files

The agents/ directory contains instructions for specialized subagents. Read them when you need to spawn the relevant subagent.

- `agents/grader.md` — How to evaluate assertions against outputs
- `agents/comparator.md` — How to do blind A/B comparison between two outputs
- `agents/analyzer.md` — How to analyze why one version beat another

The references/ directory has additional documentation:
- `references/schemas.md` — JSON structures for evals.json, grading.json, etc.

---

Repeating one more time the core loop here for emphasis:

- Figure out what the skill is about
- Draft or edit the skill
- Create the lightest useful file set: usually `SKILL.md`, sometimes `references/`, rarely `scripts/`
- In the canvas, submit the complete draft with `_save_user_skill`, then tell the user the skill is ready to try and summarize the files
- Sanity-check with a few realistic prompts when useful
- Use subagents, benchmark.json, `eval-viewer/generate_review.py`, description optimization, or packaging only when the user asks or the skill genuinely needs rigorous validation/distribution

Please add steps to your TodoList, if you have such a thing, to make sure you don't forget. In Cowork/, the default TodoList should include drafting the skill, committing it with `_save_user_skill`, and summarizing it for the user; add eval viewer or benchmark steps only when you intentionally enter the advanced workflow.

Good luck!