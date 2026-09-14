# CLI Services

This folder keeps third-party CLI setup scripts grouped by platform.

## OpenAI Codex CLI

- Windows install/update: `CLI/windows/openai/1-install_openai_codex_cli.bat`
- Windows start/sign in: `CLI/windows/openai/2-start_openai_codex_cli.bat`
- macOS: `CLI/macos/openai/install_openai_codex_cli.command`
- Linux: `CLI/linux/openai/install_openai_codex_cli.sh`

After installation, open a new terminal and run:

```bash
codex
```

The first run prompts you to sign in with a ChatGPT account or an API key.

## Gemini CLI

- Windows install/update: `CLI/windows/gemini/1-install_gemini_cli.bat`
- Windows start/sign in: `CLI/windows/gemini/2-start_gemini_cli.bat`

After installation, open a new terminal and run:

```bash
gemini
```

The first run prompts you to sign in with your Google account or configure Gemini authentication.

## Jimeng CLI

- Windows install/update: `CLI/windows/jimeng/install_jimeng_cli.bat`
- Windows login/check: `CLI/windows/jimeng/login_jimeng_cli.bat`
- Windows WSL Ubuntu helper: `CLI/windows/jimeng/install_wsl_ubuntu.bat`
- macOS install/update: `CLI/macos/jimeng/install_jimeng_cli.command`
- macOS login/check: `CLI/macos/jimeng/login_jimeng_cli.command`

Root-level scripts are kept as compatibility launchers.
