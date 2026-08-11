# OMPChamber

> **OMPChamber** is a desktop client for the [OMP](https://omp.sh) agent runtime
> (Oh My Pi), built on the [OpenChamber](https://github.com/openchamber/openchamber)
> UI/UX foundation. OpenChamber owns the product experience; OMP owns the agent
> capability.
>
> This repository is derived from OpenChamber, with the agent kernel (Models,
> Tools, Sessions, Skills, MCP, Subagents) provided by OMP instead of OpenCode.
> See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution.

## Run agent work. Keep control. Ship from anywhere.

**OMPChamber is a desktop workspace for running, supervising, and reviewing OMP agent work, powered by the OpenChamber UI.**

OMPChamber gives you one place to direct agent work, understand the changes, and move them toward release. Your projects stay available when you switch devices or step away.

![OMPChamber Chat](docs/references/chat_example.png)

<details>
<summary>More screenshots</summary>

![VS Code Extension](packages/vscode/extension.jpg)

<p>
<img src="docs/references/pwa_chat_example.png" width="45%" alt="OMPChamber PWA chat">
<img src="docs/references/pwa_diff_example.png" width="45%" alt="OMPChamber PWA diff review">
</p>

</details>

## What you can do with OMPChamber

### Goals that continue on their own

Give a session a finish line with **Session Goals**. OMPChamber checks the result after every turn and keeps the agent working until the goal is complete, blocked, or reaches the limit you set — even after you close the app.

### Compare and combine runs

Use **Multi-run** to give the same task to up to five models, each in its own session and optionally its own worktree. See what each one actually built, choose the best result, or use **Fusion** to combine the strongest parts into a new session.

### Guided changes walkthroughs

**Changes Walkthrough** turns a large diff into an AI-guided tour of the change. It groups related edits into steps, puts them in the order the change makes sense, and explains how the pieces fit together.

### Inspect a running app

Open your app beside the conversation with **Preview**. Point at an element and send the agent its screenshot, styles, position, and browser errors — all the context behind “this thing here.” Desktop brings the same workflow to any web page through its built-in browser.

### GitHub context from issue to pull request

Start a session from a GitHub issue or pull request with its context attached. Send failed checks or review comments back to the agent, then update or merge the pull request from OMPChamber.

### Continue on another device

Open the same projects and sessions from Desktop, Web/PWA, VS Code, iOS, or Android. Check progress, answer questions, review changes, and reattach to a running terminal.

### Private remote access

Pair a device with a one-time QR code and connect through **Private Relay** without opening ports or exposing a public server. The connection is end-to-end encrypted and can be revoked at any time. Direct connections, LAN/VPN access, Cloudflare/Ngrok tunnels, and SSH are also supported.

### Track work across projects

See which sessions are working, waiting, finished, or failed, along with approvals, scheduled tasks, provider limits, token use, and costs. Organize sessions into folders and keep notes, todos, and reusable project actions nearby.

### Schedule recurring work

Run a prompt once, daily, weekly, or on a cron schedule. Scheduled tasks can use Session Goals, so they continue toward an outcome instead of stopping after one response.

## Use it where you work

| Surface | Role |
| --- | --- |
| **Desktop** | The complete workspace for macOS, Windows, and Linux, with multiple windows, Mini Chat, remote machines, SSH, and native notifications |
| **Web / PWA** | Open your workspace in a browser, install it as an app, and stay up to date through background notifications |
| **VS Code** | Keep sessions beside your code, send selections to the agent, open results in the editor, and compare parallel runs |
| **iOS / Android** | Review and steer work away from your desk, receive completion alerts, and use the terminal with touch controls |
| **CLI / Server** | Run OMPChamber on a workstation or server, schedule work, manage remote access, and keep it available after login |

## Quick start

### Desktop — macOS, Windows, and Linux

Download the latest release from [GitHub Releases](https://github.com/realchendahuang/OMPChamber/releases/latest). Desktop bundles the matching OMP CLI, so no separate OMP installation is required.

Linux releases are available as x86_64 and ARM64 AppImages. Make the downloaded AppImage executable and keep it in a writable location for in-app updates:

```bash
chmod +x OMPChamber-*.AppImage
./OMPChamber-*.AppImage
```

Linux AppImages require FUSE (`libfuse.so.2`). Without FUSE, run with `APPIMAGE_EXTRACT_AND_RUN=1`.

### VS Code

Install [OMPChamber from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=fedaykindev.ompchamber), or search for “OMPChamber” in Extensions.

### CLI — Web and PWA

Requires Node.js 22+ and the [OMP CLI](https://omp.sh) (`npm install -g @oh-my-pi/pi-coding-agent`).

```bash
curl -fsSL https://raw.githubusercontent.com/realchendahuang/OMPChamber/main/scripts/install.sh | bash
ompchamber --ui-password be-creative-here
```

Common operations:

```bash
ompchamber status
ompchamber connect-url --qr
ompchamber tunnel start --provider cloudflare --mode quick --qr
ompchamber startup enable
ompchamber logs
ompchamber stop
ompchamber update
```

OMPChamber binds to localhost by default. Use `--lan` only on a trusted network and protect browser access with `--ui-password`.

## Guides

Go deeper with the OMPChamber guides:

- [Quick start](packages/docs/content/docs/quickstart.mdx)
- [Installation](packages/docs/content/docs/install.mdx)
- [Connect devices](packages/docs/content/docs/connect-devices.mdx)
- [Private Relay](packages/docs/content/docs/private-relay.mdx)
- [Multi-run](packages/docs/content/docs/multi-run.mdx)
- [Session Goals](packages/docs/content/docs/session-goals.mdx)
- [Changes Walkthrough](packages/docs/content/docs/walkthrough.mdx)
- [Preview and dev servers](packages/docs/content/docs/preview.mdx)
- [GitHub workflows](packages/docs/content/docs/github.mdx)
- [Mobile](packages/docs/content/docs/mobile.mdx)
- [Security](packages/docs/content/docs/security.mdx)
- [Troubleshooting](packages/docs/content/docs/troubleshooting.mdx)

For self-hosting details, see the [reverse proxy guide](docs/REVERSE_PROXY.md). For custom theme authoring, see the [custom themes guide](docs/CUSTOM_THEMES.md).

## Why OMP?

OMPChamber uses [OMP](https://omp.sh) (Oh My Pi) to power its coding agents, on top of the [OpenChamber](https://github.com/openchamber/openchamber) product and UI foundation. We chose OMP because it provides a capable, extensible, and open agentic coding engine — and OpenChamber because it delivers the best workspace experience around one.

Around that foundation, OMPChamber brings together the work that happens before, during, and after an agent run — deciding what to try, keeping it on track, reviewing the result, connecting from anywhere, and getting the change shipped.

OMPChamber is an independent project and is not affiliated with the OMP or OpenChamber teams.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines. Documentation authoring guidance lives in [`packages/docs`](packages/docs/README.md).

## Acknowledgments

Special thanks to:

- [OpenChamber](https://github.com/openchamber/openchamber) for the product experience and UI foundation this project builds on
- [OMP](https://omp.sh) for the agent engine
- [OpenCode](https://opencode.ai) for the API and architecture that shaped the upstream ecosystem
- [Pierre](https://pierrejs-docs.vercel.app/) for its fast diff viewer and syntax highlighting
- [Ghostty-web](https://github.com/coder/ghostty-web) for its Ghostty web renderer
- [Yulia Ivashko](https://github.com/yulia-ivashko), who built the firework celebration that plays on every successful push
- Every contributor who shaped OMPChamber with code, ideas, and attention to detail

## License

MIT
