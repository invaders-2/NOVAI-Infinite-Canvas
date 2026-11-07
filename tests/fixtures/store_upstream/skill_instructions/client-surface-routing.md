# Client Surface Routing

Choose the execution surface before choosing a tool. The goal is to complete as
much of the request as the current client can actually perform without asking
the user to identify their client or pretending that Web has local-computer
access.

## Trust the runtime surface signal

Read the ` Client Surface` section in the runtime context and treat it as
the source of truth for this turn.

- `desktop-capable` means Desktop confirmation tools may be used for local
 actions. It does not mean that every Desktop permission is already enabled.
- `web-only` means Desktop tools are unavailable. Do not call them, imply that
 a local action ran, or give Desktop permission-setting instructions as if the
 user were already in Desktop.
- Never infer the current surface from the user's wording, operating system, a
 filename, or previous turns. Never ask which client they are using when the
 runtime surface signal already answers the capability question.

## Classify the requested action

Route each requested action independently.

### Desktop-local actions

Treat an action as Desktop-local when it requires the user's current computer,
including:

- opening an installed application;
- seeing or capturing the visible screen;
- picking, listing, reading, writing, deleting, or revealing local files and
 folders;
- running a shell command or changing a local system setting.

In `desktop-capable` mode, use the narrowest matching Desktop tool:

| User intent | Tool |
| --- | --- |
| Open a supported installed app | `desktop_open_app` |
| Inspect or capture visible screen content | `desktop_capture_screen` |
| Work with local files or folders | `desktop_fs` |
| Run a command-line or otherwise unsupported system task | `desktop_shell_command` |

Do not use shell commands to imitate a dedicated app, screen, or filesystem
tool. Calling a Desktop tool starts its confirmation and authorization flow;
do not ask the user whether a popup appeared before making the call.

### Batch local files in one authorization

When the user asks about a directory, multiple files or images, all files in a
folder, or batch analysis, use one `desktop_fs` call with
`operation=batch_upload`. Do not loop over `pick_file`, `read`, or `upload`,
because every separate Desktop tool call may require another confirmation.

- Reuse `directory_grant_id` when an authorized directory already covers the
 requested files.
- Otherwise set `batch_source=pick_directory` so the user authorizes the folder
 once. Use `batch_source=pick_files` only when the user wants to choose several
 individual files instead of a folder.
- Set `recursive=false` when only the selected folder's direct children are
 needed; use recursive traversal only when the request includes subfolders.
- Use `max_files` and `max_total_bytes` as batch guardrails. If the requested
 set exceeds a limit, explain the limit and ask the user to narrow or split
 the batch instead of silently processing an arbitrary subset.
- Reserve single-file `pick_file`, `read`, and `upload` for a request that
 explicitly targets one file, or for a later targeted follow-up after the
 batch result identifies a specific file.

After `batch_upload` succeeds, use the returned cloud file ids for subsequent
analysis. Do not request local authorization again for those uploaded files.

### List a complete directory tree in one authorization

When the user asks to completely inspect a directory, list everything under it,
or include subdirectories, use `desktop_fs` `operation=list_tree` when that
operation is exposed by the current client.

- Make exactly one `list_tree` call with the root `directory_grant_id`.
- Never send `operation=list` with `recursive=true`; `recursive` belongs only
 to `batch_upload` and does not make `list` recursive.
- Do not call `list` again for directory entries returned by that tree and do
 not replace the root grant with a child entry grant.
- Treat every returned `relative_path` as relative to the original authorized
 root. Never guess or reconstruct an absolute path.
- Inspect `truncated` and `truncation_reason` before claiming the complete tree
 was returned. If it was truncated, report the boundary and ask the user to
 narrow the subtree or increase a supported guardrail.
- When `list_tree` is not exposed, never invent it. Use one
 `desktop_shell_command` scoped by the matching `cwd_grant_id` for a recursive
 listing instead of looping over child directory grants.

When the user wants files selected by their visual or semantic content, such as
"all images containing women", "all product photos", or "images in this
style", the content criterion does not turn the task into a sequence of
single-file operations. Upload every candidate media file from the authorized
directory in one `batch_upload`, classify the returned cloud files, and continue
with only the matches. Never upload one candidate, inspect it, and then ask for
another confirmation.

### Choose text read or media upload

Use `desktop_fs` `read` only when the requested local file is textual and a
text preview can answer the request. Images, video, audio, archives, and other
binary files must be uploaded before their content can be analyzed.

- For one explicitly selected binary file, use `operation=upload`.
- For multiple binary files or a directory of media, use one
 `operation=batch_upload` call.
- Do not call `read` on an image or other binary file and interpret decoded
 bytes as content.
- When a directory mixes wanted and unwanted file types, do not claim that the
 current directory batch can filter automatically. Ask the user to choose the
 wanted files with `batch_source=pick_files`, or to place them in a narrower
 folder and use `batch_source=pick_directory`.
- A semantic content condition is different from a file-type filter. For a
 request such as "find every image containing a woman", batch-upload all
 candidate image files once, then classify their content after upload. Do not
 ask the user to preselect the semantic matches.

### Handle batch limits and partial results

Treat the `batch_upload` result as an itemized result, not one unconditional
success flag.

- Inspect `success_count`, `failed_count`, `truncated`, `truncation_reason`,
 and every returned item before reporting completion.
- Continue the requested analysis with successfully uploaded file ids when
 that is still useful, and name failed files with their returned errors.
- Never say that all files were processed when any item failed, `truncated` is
 true, or the result contains fewer files than the user explicitly requested.
- If the requested set is known to exceed `max_files` or `max_total_bytes`, ask
 the user to narrow or split the selection. Reuse the same directory grant for
 later batches when possible; do not request the same folder authorization
 again.
- If `truncation_reason=legacy_client_unknown`, use the successful items but
 explain that this Desktop version cannot verify batch completeness. Recommend
 updating Desktop before claiming the whole directory was processed; do not
 repeatedly request the same directory authorization.
- Do not invent pagination, file-type filters, or a continuation token that the
 tool does not provide.

### Reuse and recover directory grants

- Reuse a matching `directory_grant_id` for later operations in the same
 authorized directory, including targeted follow-ups after a batch upload.
- When several grants could match, use their display names to ask one concise
 disambiguation question instead of opening another picker arbitrarily.
- For multiple directories, process one directory batch at a time and reuse
 each directory's grant. Keep their results separate so files are not
 attributed to the wrong directory.
- If a grant is unavailable or expired, do not retry it repeatedly. Explain
 that the directory must be authorized again and wait for the user before
 starting one new `pick_directory` flow.

### Keep work inside the authorized directory

Treat the selected or matching `directory_grant_id` as the workspace root for
the local task. A display name such as `` is only a label; it is never an
absolute path and must not be expanded to `~/`, `/Users/<name>/`, or
any other guessed location.

- Keep subsequent list, read, write, upload, reveal, and command work inside
 that grant unless the user explicitly requests a different directory.
- Use relative paths beneath the grant. Never search the home directory or the
 whole computer to rediscover a file that is already covered by the grant.
- Do not use `..`, an absolute path, or a second directory picker to escape or
 recreate the authorized workspace.
- When the current `desktop_fs` operation enum exposes `organize`, use one
 `organize` call for all required `mkdir`, `move`, and `rename` actions inside
 the grant. Submit relative paths and one ordered action list so the Desktop
 host can preflight and confirm the whole operation once.
- When `organize` is not exposed, use one `desktop_shell_command` with the same
 `cwd_grant_id` and relative paths. Put all required steps in that one command
 so the user confirms once. Do not run shell first with a guessed path and then
 request another filesystem grant.
- If the requested source is outside the authorized workspace, ask for one new
 matching directory authorization instead of searching broadly or guessing
 where it lives.

### Keep local and cloud files separate

- Use `desktop_fs` `upload` or `batch_upload` only to bring local Desktop files
 into cloud-backed analysis.
- Use existing cloud file ids directly. Do not download a cloud file locally
 and upload it again merely to make it available to the Agent.
- Treat the destination named by the user as authoritative. In
 `desktop-capable` mode, when the user names a local directory, Flow folder,
 authorized directory grant, or says to save files into "my folder", use
 `desktop_fs` `write` with `content_file_id` and reuse one
 `directory_grant_id`. For multiple files, use `batch_write` only when the
 current client capability prompt and `desktop_fs` operation enum expose it.
- `batch_download_files` always uses the browser download flow, including when
is running inside Desktop. Use it only when the user wants a browser
 or default download and has not requested a local Desktop directory.
- Never use `desktop_shell_command`, `curl`, `wget`, or another shell command to
 transfer cloud or Canvas files.
- Do not use either download path to read local Desktop files.

### Batch cloud files into one local directory

When multiple cloud or Canvas files must be written into one Desktop directory
and the current client exposes `operation=batch_write`, use one `desktop_fs`
batch call.

- Resolve every Canvas source node to its current cloud `file_id` before calling
 `desktop_fs`. Batch all node ids into one ` node get... --format json`
 lookup when possible, then use the returned `file_id` values and media types
 to build the output names.
- A Canvas `node_id`, `node_ref`, raw node UUID, or value such as `node/<id>` is
 not a `content_file_id`. Never copy any of those values into `write` or
 `batch_write`, even when a canvas selection result lists them beside the
 requested media.
- Do not start the Desktop confirmation flow until every requested Canvas item
 has a real cloud `file_id`. If any node has no downloadable `file_id`, report
 that item and stop before confirmation instead of trying node references and
 retrying after the user confirms.
- Provide one item per output file with a plain `file_name` and its
 `content_file_id`.
- Reuse a matching `directory_grant_id`. If no grant exists, let the Desktop
 confirmation flow request the directory once.
- Inspect `success_count`, `failed_count`, and every returned item. Do not claim
 full success when any item failed.
- Do not loop over `write`, and do not switch to `batch_download_files` or shell
 merely because several cloud files are involved.

When `batch_write` is not exposed, never invent or call it. Select or reuse one
directory grant, then call `write` serially for each cloud file. Only use
`batch_download_files` instead when the user accepts the browser/default
download destination.

### Protect write and delete operations

Do not generalize the batch-read or batch-write rule into destructive batch
behavior. Before writing or deleting, identify the exact target and preserve
the confirmation boundary. Never delete several files merely because the user
authorized their parent directory for reading, upload, or batch write. If the
user asks for a multi-file delete that the current tool cannot express safely
in one request, explain the limitation and ask them to narrow the operation.

### Web and cloud actions

Treat an action as Web or cloud when it operates on the canvas Canvas data, cloud
assets, downloadable cloud files, web research, or a connected plugin. Use the
matching, Canvas, download, web, or plugin capability even when the
current mode is `desktop-capable`. Being in Desktop does not turn every request
into a local shell task.

In `web-only` mode, continue with these capabilities whenever they can satisfy
the request. If the request truly depends on the user's local computer, explain
that the action requires Desktop. Do not claim completion and do not
replace the unavailable local action with an unrelated Web action.

## Handle mixed requests step by step

When one request contains both Web/cloud and Desktop-local work:

1. Split it into explicit actions and route each action separately.
2. Complete safe Web/cloud work with Web-capable tools.
3. In `desktop-capable` mode, use the appropriate Desktop tool for each local
 action and respect its confirmation boundary.
4. In `web-only` mode, complete only the independent Web/cloud portion, then
 identify the remaining local action and say it requires Desktop.
5. Do not claim the overall request is complete while a required local action
 remains unavailable, rejected, or unconfirmed.

## Treat availability and permission separately

Desktop capability availability only means the current runtime can start the
flow. The user may still reject confirmation or disable a specific permission.

- If a Desktop result reports that permission is disabled, do not retry the
 same tool automatically. Name the required Desktop permission in plain
 language, ask the user to enable it in Desktop Settings if they want to
 continue, and wait.
- If the user rejects or cancels confirmation, stop that local action without
 treating it as a system error or silently switching tools.
- Never downgrade a permission failure to a Web workaround that cannot perform
 the same local action.

## Final response check

Before reporting success, verify that every claimed action has a successful
tool result on the surface that can actually perform it. Clearly distinguish
completed Web/cloud work, completed Desktop work, and any local work that still
requires Desktop access or user permission.