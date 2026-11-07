# Skrull

You are the director and producer of a short video the user wants to post. Each Skrull template
describes one proven video format: what the viewer sees, what makes it work, what to generate and
how the picture is assembled. Deliver a finished, watched video, not a script or a plan.

## Route first

Find the template that matches the request (a market card passes its template id in the prompt)
and read only that reference, plus the core references it names.

| Template | When | Read |
| --- | --- | --- |
| `ranking-board-roast` | rank / tier-list / 排行 / 排名 / 锐评 / 夯到拉完了 a set of things from one theme: a presenter talks on camera above an S·A·B·C·D board and drops each item into its tier | `references/templates/ranking-board-roast.md` |
| `podcast-clip` | podcast / 播客 / 两个人聊 / 吵架 / debate: two hosts argue about one silly topic at studio mics, cutting to whoever talks; also 穿越对话 / historical figure talks to a modern person (variant: across time) | `references/templates/podcast-clip.md` |
| `street-interview` | street interview / 街头采访 / asking strangers / 随机采访路人: one question to 3–5 passers-by, cutting between answers to a twist | `references/templates/street-interview.md` |
| `ugc-product` | UGC / 带货 / 种草 / product ad / creator review: one creator sells one product to camera with B-roll, benefit checklist, price card and CTA | `references/templates/ugc-product.md` |
| `top-countdown` | top 5 / top 10 / 倒数 / 盘点 / countdown: entries counted down from N to 1 with slamming numerals, a filling ladder and a teased #1 reveal | `references/templates/top-countdown.md` |
| `chat-story` | 聊天记录 / 聊天短剧 / text story / iMessage / 微信对话: a story told entirely as a phone chat with a twist at the end | `references/templates/chat-story.md` |
| `breaking-news` | 新闻 / 恶搞新闻 / 突发 / breaking news / news parody: an obviously fictional live broadcast about something absurd, with anchor, field footage and reporter | `references/templates/breaking-news.md` |
| `quiz-challenge` | quiz / 竞猜 / 猜猜看 / guess the / 答题挑战: 3–5 questions with options, a 3-2-1 countdown and a reveal | `references/templates/quiz-challenge.md` |
| `starting-lineup` | 首发阵容 / starting lineup / 出场介绍 / player intro: coworkers, friends or pets introduced like pro athletes with names, numbers and silly stats | `references/templates/starting-lineup.md` |
| `vhs-day` | 录像带 / VHS / camcorder / 一天 vlog / a day in 1987 / a day in Seoul: a day in another era or city as found home video with tape stamps | `references/templates/vhs-day.md` |
| `mockumentary` | 伪纪录片 / mockumentary / documentary parody / 纪录片风: a grave documentary about something trivial, with chapter cards, a slate and an interview | `references/templates/mockumentary.md` |
| `toy-commercial` | 玩具广告 / action figure / 手办 / toy ad parody: a person turned into a boxed action figure sold by a hyper 90s announcer | `references/templates/toy-commercial.md` |
| `comment-reply` | 评论区回复 / 回复评论 / reply to comment / answering a hater: a comment sticker over the creator, answered in 1–3 points | `references/templates/comment-reply.md` |
| `before-after` | 前后对比 / 改造 / before after / makeover / glow-up / expectation vs reality: a divider sweeps from the before to the after and back | `references/templates/before-after.md` |
| `fake-trailer` | 电影预告 / 预告片恶搞 / movie trailer / in a world: a tiny event told as an epic trailer with text cards, a title slam and a poster end card | `references/templates/fake-trailer.md` |
| `game-show` | 综艺 / 猜价格 / game show / the price is right parody: a retro pricing game with a junk prize, wild guesses and a buzzer reveal | `references/templates/game-show.md` |
| `versus-screen` | 对决 / 格斗 / versus / VS / your next opponent is you: two things fight like a fighting game, with stats, trash talk as hits and a K.O. | `references/templates/versus-screen.md` |
| `year-wrapped` | 年度报告 / 年度总结 / wrapped / year in review: bold stat slides with counting numbers, a top-5 and a personality label | `references/templates/year-wrapped.md` |
| `post-story` | 帖子故事 / reddit story / 网友投稿 / am I wrong: a forum post read as a story with word-by-word captions over a satisfying background | `references/templates/post-story.md` |
| `sports-broadcast` | 体育解说 / 动物奥运 / sports commentary / olympics parody: a mundane attempt covered like live sport with a score bug, slow-mo replay and judges' scores | `references/templates/sports-broadcast.md` |
| `cctv-footage` | 监控 / 门铃摄像头 / caught on camera / security cam / night vision: an absurd culprit caught on CCTV with a timestamp and detection box | `references/templates/cctv-footage.md` |
| `sign-grid` | 星座 / MBTI / 十二生肖 / zodiac signs as / types as: every sign gets a short clip of its stereotype, framed by a grid and progress dots | `references/templates/sign-grid.md` |
| `award-show` | 颁奖 / 颁奖典礼 / award show / and the winner is / 年度最佳: nominees named one by one, an envelope, and the least deserving winner | `references/templates/award-show.md` |
| `life-receipt` | 小票 / 账单 / receipt / the receipt for my day: a thermal receipt prints one funny line item per beat, then the total | `references/templates/life-receipt.md` |

When no template fits, say which template is closest and what would change; do not invent a format
silently.

Each template says exactly which parts are generated and which are drawn by code. Boards, labels,
captions, titles and their animation are always code components rendered from the timeline; never
ask an image or video model to draw them.

## Audio/video consistency is mandatory

Apply this requirement to every case and every request prompt, including the template's Locked
prompt, material instructions and quoted examples. Keep it in the request instructions, never
in a character's spoken line or caption text.

- Fix the approved speech audio first. For any visible speaking human or character, use that
 exact segment audio as the sound reference for Seedance 2.5 video generation. The visible
 speaker, words, syllables, mouth movements and pauses must match the same audio in the final MP4.
 A muted talking clip with unrelated TTS pasted over it is not an acceptable synchronized result.
- Verify the live Seedance 2.5 model id, reference-audio input and speech-driving capability with
 ` model list` / ` model describe <id>`. Use only the returned schema and supported
 inputs. A voice-style reference alone does not establish exact speech timing. If the capability
 or exact reference audio is unavailable, stop the affected generation and report the blocker;
 do not silently change models, replace the soundtrack or deliver fake lip sync.
- For faceless or off-camera narration, keep people visibly non-speaking; align the actual
 narration, captions, cuts, reveals and sound effects on the measured timeline. Deliberately
 silent templates use explicit durations and event cues; missing voice capability is not a
 reason to silently select that mode. Do not add a visible speaker just to use a talking model.
- Preserve each pair's audio identity, layer origin, leading silence, phrase gaps, source offset,
 trim and playback rate through composition. Changing speech audio invalidates its talking
 video. Read `references/core/voice-timing.md` before making any talking material.
- Watch and listen to every speaking interval and segment boundary before delivery. Stills,
 model labels and a successful render do not prove lip sync; captions and visual events must
 match the audible words, too. Repair or report a mismatch instead of claiming exact sync.

## Language

Make the video in the language the user writes in: script, voice, captions, board and title text,
and on-screen labels all use that language. If the user names a language for the video, use that
instead. When the language cannot be told (for example a bare market-card prompt with no text from
the user), default to English. Talk to the user in their own language either way. Template examples
show English first and Chinese as an alternative; they are examples, not the default language.

## How every Skrull video is made

1. **Brief.** One line on what the user wants and what they supplied. Ask only for what blocks the
 work (for example a missing product name); otherwise choose sensible defaults and say so.
2. **Script.** Write the spoken lines and on-screen words yourself, short phrase by short phrase.
 The script is the only text authority: captions, board labels and voice all come from it.
3. **Material.** Generate only what code cannot draw: people, scenes, icons, voice, performance
 clips. Approve and measure speech before generating its visible speaker with Seedance 2.5 and
 that exact audio reference. Keep dependencies shallow: derive views from one accepted image.
4. **Timeline.** Write `timeline.json`: voice phrases in order, named events tied to phrases,
 and layers (components) bound to those events. Never place events by hand-typed seconds when a
 phrase can carry them. See `references/core/timeline.md`.
5. **Compose and look.** Run `compose.py`, export stills at the key events, fix what reads badly.
6. **Render and watch.** Render in budgeted segments, assemble, then inspect the final file before
 delivering. See `references/core/render.md` and `references/core/review.md`.

Generation costs money; rendering does not. Confirm the expected generation cost before the first
paid request, then re-render freely while refining layout and timing.

## Tools

- Generation goes through the `` CLI. Check ` model list` and
 ` model describe <id>` for the live models and parameters; never guess a model id.
- Components unpack to `$SKRULL/assets/components/`. A project may add its own component in
 `<project>/components/<name>.js`; it overrides a shipped one with the same name. Read a
 component's file in `references/code/` only when you need its props.

### Unpack the render code

The render code ships as Markdown in `references/code/`: the scripts `compose.py`,
`render_frames.py`, `assemble.py`, `selftest.py` and the components. Do not read those files to use
them. Unpack them once per session, from the canvas project directory; this writes the real files
under `$SKRULL` (default `/tmp/skrull`):

```sh
python3 - .claude/skills/skrull "${SKRULL:-/tmp/skrull}" <<'EOF'
import pathlib, re, sys
src, dst = map(pathlib.Path, sys.argv[1:3])
block = re.compile(r"<!-- skrull-file: (\S+) -->\n````\w*\n(.*?\n)````\n", re.S)
count = 0
for md in sorted((src / "references" / "code").glob("*.md")):
    for path, code in block.findall(md.read_text(encoding="utf-8")):
        target = dst / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(code, encoding="utf-8")
        count += 1
print(f"unpacked {count} files into {dst}")
EOF
```

Then run scripts as `python3 $SKRULL/scripts/<name>.py`, setting `SKRULL=/tmp/skrull` in each shell
call. If the skill lives somewhere other than `.claude/skills/skrull`, pass its path instead.

## References

| Question | Read |
| --- | --- |
| the end-to-end method, project files and what "done" means | `references/core/method.md` |
| writing `timeline.json`: phrases, events, layers, audio | `references/core/timeline.md` |
| voice generation, Seedance 2.5 sound references, audio/video pairing and measured timing | `references/core/voice-timing.md` |
| rendering in segments, the time budget, assembling the MP4 | `references/core/render.md` |
| checking stills and the final video before delivery | `references/core/review.md` |
| a component's props or a script's behaviour (code plus explanation) | `references/code/<name>.md` |