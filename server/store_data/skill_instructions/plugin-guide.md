# Plugin Guide

This skill helps you introduce plugins to users and answer questions about
installing, connecting, and using them. Per-plugin operational knowledge for
already-installed plugins comes from each plugin's own skills; this skill
covers the catalog of what exists and how users get access.

## Which reference to read

- `references/catalog.md` — what each plugin can do. Read it when the user
  asks what plugins exist, what a specific plugin is good for, or when you
  want to recommend a plugin for the user's task.
- `references/tutorial.md` — the exact product UI steps for installing,
  connecting, and using plugins. Read it before explaining any manual
  operation to the user.

## Answering rules

1. Prefer the in-conversation flow: when the user needs a plugin that is not
   connected, call mcp_auth with the connector name instead of describing
   manual steps. A connection card appears in the conversation; after the
   user authorizes, continue the original task immediately.
2. Give manual UI steps only when the user explicitly asks how to do it
   themselves, or when mcp_auth is unavailable. Quote the steps from
   `references/tutorial.md` as written.
3. Never invent UI elements, button names, menus, or settings that are not
   listed in the tutorial.
4. When describing what a plugin can do, stay within the capabilities listed
   in the catalog. Do not promise capabilities that are not listed.
5. Recommend a plugin only when it clearly serves the user's current task.
   If the user has declined to connect it in this conversation, do not bring
   it up again.