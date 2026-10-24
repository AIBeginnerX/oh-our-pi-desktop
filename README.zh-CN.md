# OoP (oh-our-pi)

**一个桌面应用，统一控制你已经在用的编码智能体，还可以在其上叠加可选的多模型团队。**

[English](README.md) | [한국어](README.ko.md) | 简体中文 | [日本語](README.ja.md) | [Español](README.es.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Platform: macOS arm64 tested](https://img.shields.io/badge/platform-macOS%20arm64%20tested-lightgrey)
![Node 24](https://img.shields.io/badge/node-24.x-brightgreen)
![Status: early](https://img.shields.io/badge/status-early-orange)

OoP 运行在你自己的电脑上，封装你已经装好的编码智能体 CLI（Codex、Claude Code、Cursor、Grok Build、OpenCode、Antigravity、ZCode、MiniMax Code），并为它们提供一个统一的对话式工作区。你可以通过桌面应用、浏览器或手机来使用它。它**不是**托管服务：订阅和 API 密钥都用你自己的，代码始终留在你的电脑上。

OoP 是 T3 Tools Inc. 的 [T3 Code](https://github.com/pingdotgg/t3code)（MIT 许可）的分支，基于上游 v0.0.44。当前的 OoP 版本见 [`OOP_RELEASE.json`](OOP_RELEASE.json)。非常感谢 T3 Code 团队：这里几乎所有的基础工作都出自他们之手。

## 目录

- [为什么选择 OoP？](#为什么选择-oop)
- [截图巡览](#截图巡览)
- [功能参考](#功能参考)
- [支持的提供商](#支持的提供商)
- [平台支持](#平台支持)
- [环境要求](#环境要求)
- [安装桌面应用](#安装桌面应用)
- [安装 / 从源码构建](#安装--从源码构建)
- [从手机连接](#从手机连接)
- [更新机制](#更新机制)
- [安全与隐私](#安全与隐私)
- [常见问题 / 故障排查](#常见问题--故障排查)
- [仓库结构](#仓库结构)
- [状态、贡献与许可证](#状态与路线图说明)

## 为什么选择 OoP？

编码智能体都很好用，但每一个都待在自己的终端或应用里，有各自的登录、历史记录和审批提示。OoP 把它们放到了一起。

- **一处管理多个智能体。** 按线程在 Codex、Claude Code、Cursor、Grok Build、OpenCode、Antigravity、ZCode 和 MiniMax Code 之间切换，diff、终端和审批流程都保持一致。
- **让多个模型分担同一项任务。** OOP Crew 让一个“brain”（大脑）模型把日常工作交给更便宜的 worker，把难题交给 expert，并由 auditor 审查结果。
- **始终掌控全局。** 四种权限模式、带可恢复检查点的 diff 面板，以及让费用不再出人意料的用量页面。
- **离开键盘也能工作。** 把手机与运行智能体的电脑配对，随时关注（或指挥）耗时较长的任务。
- **一切留在本地。** 项目、提供商登录和智能体的工作都留在你的电脑上。没有 OoP 账号，也没有 OoP 服务器。

适合已经订阅一个或多个编码智能体服务或 API 套餐、能接受早期且未签名的桌面应用，
并希望使用统一控制界面的开发者。如果你想要一个打磨精良、已签名、可自动更新的产品，
目前上游的 T3 Code 更合适。

### 30 秒速览

![OoP 主聊天视图，包含输入框、模型选择器和权限模式](docs/screenshots/chat.png)
_主聊天视图：选择提供商和模型，设置权限模式，并跟进线程。_

1. 打开 OoP，登录一个提供商（Settings → Providers）。
2. 添加一个项目文件夹并新建线程。
3. 在输入框中选择模型和权限模式，然后发送消息。
4. 在 diff 面板中查看结果；如果不满意，可以从检查点恢复。

## 截图巡览

所有截图均来自不含任何个人数据的独立演示配置。

### 聊天

主工作区。每个项目有若干线程；每个线程是与一个提供商、一个模型的对话。输入框里包含模型选择器、权限模式，以及 Crew 和 Goal 控件。

**打开方式：** 添加项目，然后从侧边栏新建线程。

![带有输入框、模型选择器和权限模式的主聊天界面](docs/screenshots/chat.png)
_聊天：线程时间线下方是带模型选择器和权限模式的输入框。_

### OOP Crew

一个聊天，多个模型。聊天自身的模型就是 **brain**（大脑），负责规划并与你交流。**worker** 承担日常工作（搜索、编辑、测试），**expert** 承担高难度的实现，**auditor** 审查改动过文件的轮次。预设有 **OOP pick**（OOP 精选）、**Speed**（速度）、**Quality**（质量）和 **Budget**（预算），也可以按角色单独指定模型。如果某个 crew 模型出错（例如额度用完），OoP 会把任务交给另一个同级别且已登录的模型。20 行及以内、且测试通过的小改动不会被审查。

**适用场景：** 较大的任务，希望大部分工作用便宜的模型完成，再由强模型把关。**打开方式：** 输入框中模型选择器旁边的 **Crew**。Crew 的工作会实时显示在右侧面板的 **Workflows** 和 **Agents** 下。

![OOP Crew 看板，展示 brain 模型把任务分派给 worker 和 auditor](docs/screenshots/crew.png)
_OOP Crew：一个聊天，多个模型，并有实时看板显示谁在做什么。_

> [!NOTE]
> Crew 在每个聊天中运行多个模型，因此会成倍增加提供商的用量。如果你在意费用，请先从 **Budget** 预设开始。

### Providers（提供商）

在一处完成每个提供商的安装、更新和登录。卡片会显示 CLI 是否已安装、是否已登录，并提供 **Install**（当 `npm` 在你的 `PATH` 中时）或 **Update now**（当 OoP 知道是哪个安装器安装了该 CLI 时）。

**打开方式：** Settings → Providers。

![Settings 的 Providers 页面，显示每个提供商的安装、更新和登录状态](docs/screenshots/providers.png)
_Settings → Providers：安装、更新并登录各个提供商。_

### 添加 Z.AI 或 MiniMax（OpenCode 预设）

Z.AI（API 或 Coding Plan）和 MiniMax（API 或 Token Plan）的预设，通过 OpenCode 运行，这样你无需手写 OpenCode 配置就能使用这些模型。API 密钥保存为实例变量（`OOP_ZAI_API_KEY` / `OOP_MINIMAX_API_KEY`）。

**打开方式：** Settings → Providers → Add。需要 OpenCode 1.14.19 或更高版本。

![包含 Z.AI 和 MiniMax 预设的添加提供商对话框](docs/screenshots/add-provider.png)
_添加提供商：通过 OpenCode 运行的 Z.AI 和 MiniMax 预设。_

> [!NOTE]
> 本分支尚未测试付费的 Z.AI / MiniMax 登录和聊天请求。

### Diff 与审查

准确查看智能体在某个线程中改了什么，进行审查，并可从每轮结束时创建的检查点恢复。检查点是隐藏的 git 引用，不会弄乱你的分支。

**打开方式：** 右侧面板中的 **Diff** 标签页（位于 git 仓库中的服务器线程）。

![Diff 面板，显示智能体在线程中所做的改动](docs/screenshots/diff.png)
_Diff 面板：审查智能体改了什么，并可从检查点恢复。_

### 提交与源代码管理

通过运行服务器那台机器上各平台自带的 CLI 连接 GitHub、GitLab、Forgejo/Gitea、Bitbucket 或 Azure DevOps，然后直接在线程中提交、发布并发起拉取请求。

**打开方式：** 先在 Settings → Source Control 中检测你的 CLI（登录后点击 **Rescan**），然后使用线程上的提交控件。

![线程的提交与源代码管理操作](docs/screenshots/commit.png)
_源代码管理：在线程中提交改动并发布。_

### 权限模式

选择智能体在行动前何时必须先询问你。该模式按线程生效。

| 模式                  | 行为                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| **Supervised**        | 命令和文件改动都需要审批。                                                                      |
| **Auto-accept edits** | 自动批准文件编辑；其他操作仍可能询问。                                                          |
| **Auto**              | 对常规操作使用提供商的自动审查，其余仍会询问（Codex、Claude、Cursor；其他提供商会退回为询问）。 |
| **Full access**       | 命令和编辑无需审批提示直接运行。这是新线程的**默认**模式。                                      |

**打开方式：** 输入框中的模式选择器。默认值可在 Settings → General → New threads → Permissions 中更改。

![输入框中的权限模式选择器](docs/screenshots/permissions.png)
_权限模式：从 Supervised 到 Full access。_

### 线程目标

描述聊天结束时应当达成的状态。目标未完成期间，每轮结束后 OoP 都会继续推进该线程，直到智能体报告 `GOAL COMPLETE`、报告 `GOAL BLOCKED: <reason>`，或你设定的自动继续次数用完。在使用 Crew 时，改动了文件的轮次只有通过审查后才会计入。

**打开方式：** 输入框中 **Crew** 旁边的 **Goal**。使用 **Stop goal** 结束目标。

![输入框中的 Goal 控件，显示已使用的继续次数](docs/screenshots/goal.png)
_线程目标：聊天会一直继续，直到目标完成、受阻或被停止。_

### 聊天中的报告

当回答包含数字或流程时，智能体可以用图表、关键数据卡片、进度条和流程图来呈现，而不是一大段文字。每个图都有 **Source** 按钮，可查看背后的数据。

**试一试：** 让智能体画一张图表或流程图。

![聊天回复中绘制的图表和统计卡片](docs/screenshots/reports.png)
_报告：在对话中渲染图表和关键数据。_

### Workflows 与 Agents 面板

实时图表展示智能体正在做什么：每次工具调用、子智能体或提供商工作流都是一张卡片，并行的工作共用一列，选中的卡片会显示模型、耗时和 token 数。Crew 的工作也会显示在这里。

**打开方式：** 右侧面板（Workflows 和 Agents 标签页）、命令面板，或 `mod+alt+w`。

![Workflows 面板，以实时图表绘制线程的工具调用](docs/screenshots/workflows.png)
_Workflows 面板：实时跟进智能体的工作。_

### Usage

在已连接的服务器上，汇总所有提供商的 token 用量、缓存节省、各模型明细，以及**估算的**等价 API 费用。这些只是估算值，并非你的订阅账单。

**打开方式：** 侧边栏或命令面板中的 **Usage**，或 `mod+u`（终端未获得焦点时）。

![Usage 页面，显示各提供商的 token 和估算费用历史](docs/screenshots/usage.png)
_Usage：各提供商的 token 和估算费用历史。_

### 内置终端

每个线程一个终端，运行在服务器所在的机器上，服务器端保留最多 5,000 行（8 MiB）的回滚内容，因此重新连接后依然存在。

![聊天线程旁边的内置终端](docs/screenshots/terminal.png)
_与聊天并排的内置终端。_

### 深色主题

![深色主题下的 OoP](docs/screenshots/dark.png)
_深色主题。_

### 手机尺寸的 Web 客户端

配对之后，同一个 Web 界面可以在手机浏览器中使用（参见[从手机连接](#从手机连接)）。

![手机尺寸的 OoP Web 客户端](docs/screenshots/mobile.png)
_手机尺寸的 Web 客户端。_

### 远程访问设置

在这里开启网络访问、创建配对链接、查看已授权的客户端并撤销它们。此截图中的配对码已打码。

**打开方式：** Settings → Connections。

![Settings 的 Connections 页面，包含网络访问和配对链接（配对码已打码）](docs/screenshots/connections.png)
_Settings → Connections：远程访问与配对（配对码已打码）。_

## 功能参考

“Added in OoP”（OoP 新增）表示本分支的文档和代码将其标记为 OoP 专有。“From T3 Code”（来自 T3 Code）表示据文档和代码所示，它属于上游（v0.0.44）的一部分；本分支没有做过文件级别的 diff，所以这一划分只是大致准确。

| 功能                   | 作用                                                                                  | 位置                                         | 来源                                             |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| OOP Crew               | brain 模型把任务委派给 worker、expert 和 auditor 模型；支持预设和按角色覆盖           | 输入框 → Crew；右侧面板 → Workflows / Agents | Added in OoP                                     |
| 线程目标               | 让线程持续运行，直到检查通过或目标受阻                                                | 输入框 → Goal                                | Added in OoP                                     |
| 项目记忆               | 在输入框中推荐已保存的项目记忆                                                        | 输入框，记忆按钮                             | Added in OoP                                     |
| 本地角色偏好           | 按环境为实现或审查保存偏好的模型，并附带推荐                                          | 输入框模型选择器                             | Added in OoP                                     |
| Z.AI / MiniMax 预设    | 基于 OpenCode 的提供商预设                                                            | Settings → Providers → Add                   | Added in OoP（付费请求未测试）                   |
| ZCode (GLM) 提供商     | 通过 ACP 接入 Z.AI 的智能体                                                           | Settings → Providers                         | Added in OoP                                     |
| MiniMax Code 提供商    | 通过 ACP 接入 MiniMax 的智能体                                                        | Settings → Providers                         | Added in OoP                                     |
| 一键安装 / 更新提供商  | 在提供商卡片上安装或更新提供商 CLI                                                    | Settings → Providers                         | Added in OoP（与上游的具体差异未核实）           |
| Verify macOS build     | 在服务器所在的 Mac 上检查 OoP `.dmg` 的完整性、严格代码签名和启动情况                 | 聊天标题栏 → Verify macOS build              | Added in OoP                                     |
| 手机连接对话框         | 桌面应用中一键生成手机配对二维码，可选自有中继                                        | 侧边栏 → Connect mobile                      | Added in OoP（仅桌面应用）                       |
| 自有 Cloudflare 中继   | 你自行部署的 Worker，让手机可以从任何网络访问你的桌面                                 | `infra/oop-relay`                            | Added in OoP，早期                               |
| 本地文件夹更新器       | 打包后的 OoP 可以从你指定的文件夹中获取更新的安装包                                   | 打包的 macOS / Windows 版本                  | Added in OoP，早期，未经他人测试                 |
| 多提供商会话           | 跨提供商的线程、轮次和检查点                                                          | 各处                                         | From T3 Code                                     |
| 权限模式               | Supervised、Auto-accept edits、Auto、Full access                                      | 输入框；Settings → General                   | From T3 Code                                     |
| Diff 面板与检查点      | 审查并恢复智能体的改动                                                                | 右侧面板 → Diff                              | From T3 Code                                     |
| 源代码管理             | 通过提供商 CLI 克隆、提交、发布和发起拉取请求                                         | Settings → Source Control                    | From T3 Code                                     |
| 内置终端               | 每个线程一个终端，运行在服务器所在机器上                                              | 线程内                                       | From T3 Code                                     |
| 聊天中的报告           | 图表、统计卡片、进度条、mermaid 流程图                                                | 回复中                                       | From T3 Code                                     |
| 工作流视图             | 工具调用和子智能体的实时图表                                                          | 右侧面板，`mod+alt+w`                        | From T3 Code                                     |
| 用量页面               | token 和估算费用历史                                                                  | 侧边栏，`mod+u`                              | From T3 Code（ZCode 和 MiniMax 两行为 OoP 新增） |
| SnapShots              | 把窗口截取到你的草稿中（默认关闭；macOS、Windows、Linux Wayland）                     | Settings → SnapShots                         | From T3 Code（归属未核实）                       |
| 远程访问               | 局域网配对、Tailscale HTTPS、SSH 环境                                                 | Settings → Connections                       | From T3 Code                                     |
| 设备面板               | 在线程旁观看并点按 iOS 模拟器或 Android 模拟器                                        | 右侧面板 → Device                            | From T3 Code（此处未测试）                       |
| 后台服务               | macOS（launchd）和 Linux（systemd 用户单元）上的 `t3 service install`；不支持 Windows | CLI                                          | From T3 Code（此处未测试）                       |
| 快捷键、项目设置、主题 | 可自定义的快捷键、按项目的覆盖设置、外观                                              | Settings                                     | From T3 Code                                     |

## 支持的提供商

开始线程之前，请至少安装一个提供商 CLI 并完成登录。

| 提供商                            | 登录方式                                                                                            | 备注                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Codex                             | 安装 Codex CLI，然后运行 `codex login`（或在 Settings → Providers 中点击 **Connect with ChatGPT**） |                                                                     |
| Claude Code                       | 安装 Claude Code，然后运行 `claude auth login`                                                      | Claude 作 brain 时，会把同账号的 Claude crew 角色作为子智能体运行。 |
| Cursor                            | 安装 Cursor CLI，然后运行 `agent login`                                                             |                                                                     |
| Grok Build                        | 安装 Grok Build CLI，然后运行 `grok login`                                                          |                                                                     |
| OpenCode                          | 安装 OpenCode 1.14.19 或更高版本，然后运行 `opencode auth login`                                    | Z.AI / MiniMax 预设需要它。                                         |
| Antigravity                       | Settings → Providers：启用，点击 **Install**，然后点击 **Sign in with Google**                      | 无需 CLI。Gemini API 密钥以明文形式保存在设置中。                   |
| ZCode (GLM)                       | 安装 ZCode，运行 `zcode login zai`，然后运行 `npm i -g zcode-acp-server`                            | 无论你选择哪种权限模式，它都会不经审批地运行自己的工具。            |
| MiniMax Code                      | `npm i -g @minimax-ai/code`，然后运行 `mcode login --region global`                                 |                                                                     |
| 通过 OpenCode 使用 Z.AI / MiniMax | Settings → Providers → Add → Z.AI 或 MiniMax；把密钥填入 `OOP_ZAI_API_KEY` / `OOP_MINIMAX_API_KEY`  | 付费请求未测试。                                                    |

## 平台支持

| 平台                         | 状态                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| macOS，Apple Silicon (arm64) | **已测试。** 这是主要目标平台。                               |
| Windows x64                  | **实验性。** 由维护者构建；未在干净的机器上验证。             |
| macOS Intel                  | 本分支未测试。macOS 构建脚本会拒绝在 Intel 上运行。           |
| Linux                        | 本分支未测试。仓库中有上游的打包代码，但不作任何承诺。        |
| iOS / Android 原生应用       | 本分支未测试。参见[原生应用还是浏览器](#原生应用还是浏览器)。 |
| 手机浏览器（访问 Web 界面）  | 已按手机尺寸检查 Web 界面；参见[从手机连接](#从手机连接)。    |

## 环境要求

以下要求仅适用于从源码构建。二进制安装程序不需要 Node.js、pnpm、git 或编译器。使用智能体还需要单独安装并登录提供商 CLI。

- **Node.js 24.x，24.13.1 或更高版本**
- **pnpm 11.10.0**
- **git**
- **rsync**（macOS，构建脚本会用到）
- **至少一个提供商 CLI**，已安装并登录（参见[支持的提供商](#支持的提供商)）
- 仅 Windows 打包需要：Rust、Python 3 和 Visual Studio Build Tools（使用 C++ 的桌面开发，含 Windows SDK）

## 安装桌面应用

**macOS (Apple Silicon)**

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
```

**Windows (PowerShell, x64)**

```powershell
irm https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.ps1 | iex
```

**Linux (x64)**

```sh
curl -fsSL https://raw.githubusercontent.com/AIBeginnerX/oh-our-pi-desktop/main/scripts/install-desktop.sh | sh
```

安装位置、更新、安全和发布前提请参阅简明的[桌面安装指南](INSTALL.md)。v0.0.106
及更早的源码发布版本均不含二进制文件。请使用 v0.0.107 或更高版本，并确认相应安装程序及
`.sha256` 文件列在发布页的 **Assets** 中。

## 安装 / 从源码构建

```bash
git clone https://github.com/AIBeginnerX/oh-our-pi-desktop.git
cd oh-our-pi-desktop
```

### macOS (Apple Silicon)

请直接用 `node` 运行脚本，不要通过 `pnpm`。

```bash
node scripts/macos.mjs doctor    # checks macOS arm64, Node, pnpm, rsync
node scripts/macos.mjs setup     # installs dependencies in a local cache
node scripts/macos.mjs start     # optional: run an isolated dev copy of the desktop app
node scripts/macos.mjs package   # builds an ad hoc signed DMG into release/macos/
```

打开 `release/macos/` 中的 DMG，把应用拖到 `/Applications/OoP.app`。

### Windows（x64，实验性）

请在 Windows 电脑上构建（不支持交叉构建）。请先安装 Rust、Python 3 和 Visual Studio Build Tools（使用 C++ 的桌面开发，含 Windows SDK）。

```bat
set OOP_WINDOWS_UPDATE_DIRECTORY=%CD%\release\windows
node scripts\windows.mjs package
```

安装程序（`OoP-<version>-x64.exe`）会写入 `release\windows`。

### 通用开发路径（任意操作系统）

使用 Vite+（`vp`），即本代码库文档所采用的任务运行器（安装：`curl -fsSL https://vite.plus | bash`）；参见 [`docs/operations/development.md`](docs/operations/development.md)。

```bash
vp i          # install dependencies
vp run dev    # server + web; open the pairing URL it prints
```

### 首次运行清单（源码构建）

源码构建产物是**临时（ad hoc）签名且未经公证**的，操作系统可能会显示警告。二进制安装程序会在安装前验证 SHA-256，不会绕过 Gatekeeper 隔离属性或 Windows SmartScreen。

- **macOS（Gatekeeper）：** 右键点击应用，选择 **Open**（打开），或前往“系统设置” → “隐私与安全性” → **Open Anyway**（仍要打开）。
- **Windows（SmartScreen）：** 点击 **More info**（更多信息） → **Run anyway**（仍要运行）。

然后：

- [ ] Settings → Providers：安装并登录**一个**提供商。
- [ ] 添加一个项目（一个文件夹，最好是 git 仓库）。
- [ ] 新建线程，并在输入框中选择模型。
- [ ] 选择权限模式。新线程默认是 **Full access**；对于不信任的仓库，请使用 **Supervised**。
- [ ] 可选：开启 **Crew**，并在几轮之后查看 **Usage** 页面。

## 从手机连接

智能体、文件和提供商登录都留在你的电脑（**主机**）上。手机只是一个遥控器：它显示线程，让你发送消息并回应审批提示。主机需要保持唤醒并持续运行。

```mermaid
graph LR
    P["手机<br/>（浏览器或原生应用）"] -->|"一次性配对链接 / 二维码"| N["网络路径<br/>局域网、Tailscale 或你自己的中继"]
    N --> S["你电脑上的 OoP 服务器<br/>（校验配对，保持会话）"]
    S --> C["提供商 CLI<br/>Codex、Claude Code、Cursor 等"]
    C --> F["你的项目文件"]
```

请按下面的顺序，选择对你最简单可行的路径。

|     | 路径                     | 需要                                | 能否在离家时使用 | 风险                        |
| --- | ------------------------ | ----------------------------------- | ---------------- | --------------------------- |
| a   | 同一 Wi-Fi / 局域网      | 手机和电脑在同一网络                | 否               | 最低                        |
| b   | Tailscale                | 两台设备上都有免费的 Tailscale 账号 | 是               | 低                          |
| c   | 你自己的 Cloudflare 中继 | 一个 Cloudflare 账号和一次性部署    | 是               | 中（Cloudflare 能看到流量） |

> [!WARNING]
> **配对链接和配对码就是密码。** 切勿发布在 issue、聊天或截图中。只配对你自己的设备。切勿把服务器端口暴露到公网。离家使用时优先选择 Tailscale。撤销你不认识的设备。远程控制智能体时请使用 **Supervised** 权限模式。

### a) 同一 Wi-Fi / 局域网（最简单）

**前提条件：** 电脑上运行着 OoP 桌面应用，并且手机在同一网络中。

1. 在桌面应用中，点击侧边栏的手机图标（**Connect mobile**）。
2. 如果对话框提示移动连接已关闭，请点击 **Allow mobile connections**。OoP 会重启一次；该设置会被保留。
3. 会出现一个一次性二维码。如果提供了多个地址，请选择手机能够访问的那个（同一 Wi-Fi 下选 **LAN** 项）。
4. 用手机相机扫描二维码，并在手机浏览器中打开链接。手机就配对好了。配对会授权该设备以后继续访问，所以不需要再次输入原来的配对码。

手动方式：Settings → Connections → 开启 **Network access**，然后点击 **Create link**，并在手机上打开该链接。在那里创建的链接只有在页面保持打开时才能复制；离开页面后就需要创建新链接。

不用桌面应用运行服务器（例如走开发路径）？

```bash
t3 serve --host <your-computer's-LAN-address>   # for example 192.168.1.20
t3 pair                                          # prints a fresh pairing QR for the running server
```

在源码检出目录中，`node apps/server/src/bin.ts pair` 运行的是同一条命令。配对令牌默认有效期为 5 分钟（`--ttl` 可修改；`t3 pair --help` 会列出各选项）。像 `127.0.0.1` 这样的回环地址只能在电脑本机上使用，手机上永远无法使用。

### b) Tailscale 专用网络

**前提条件：** 一个 [Tailscale](https://tailscale.com) 账号，电脑和手机上都安装了 Tailscale，并且都登录到同一个 tailnet。

1. 在桌面应用中打开 Settings → Connections，启用 **Tailscale HTTPS**。（在同一位置关闭它即可移除该路径。）
2. 创建配对链接（或使用 **Connect mobile** 并选择 Tailscale 路径）。链接形如 `https://your-computer.your-tailnet.ts.net/`。
3. 在手机上打开该链接（手机上的 Tailscale 必须处于已连接状态）。

对于命令行服务器：

```bash
t3 serve --tailscale-serve     # start a server published over Tailscale HTTPS
t3 pair --tailscale            # for an already-running server
tailscale serve --https=443 off   # remove the mapping later
```

如果 443 端口已被占用，可用 `--tailscale-serve-port` 另选一个。Tailscale 流量不会经过任何公共中继。

### c) 你自己的 Cloudflare 中继（离家使用，不用 Tailscale）

OoP 在 [`infra/oop-relay`](infra/oop-relay/README.md) 中附带了一个小型 Cloudflare Worker，部署到**你自己的** Cloudflare 账号即可。桌面端主动向它建立连接，因此无需设置路由器，只要桌面在线，手机就能从任何网络连接。

1. 按照 [`infra/oop-relay/README.md`](infra/oop-relay/README.md) 部署该 Worker（`npx wrangler login`、`npx wrangler deploy`，然后 `npx wrangler secret put OOP_RELAY_SECRET`）。
2. 在桌面应用中：Connect mobile → **Use away from home**。把显示的密钥粘贴到 Worker 的 secret 中，输入中继地址并点击 **Save**。
3. 选择 **Cloudflare relay** 作为路径，然后扫描二维码。

> [!NOTE]
> 一次部署只服务一台桌面。Cloudflare 会为中继终结 TLS，因此运行它的那个 Cloudflare 账号可以看到流量。手机仍然需要用配对码登录桌面。这条路径是新增的，三者中测试最少。

**那 T3 Connect 呢？** T3 Code 还提供了“T3 Connect”，这是一个依赖云端登录和上游项目所运营服务器的隧道服务。**OoP 不运营任何托管服务**，并且本分支没有测试过 T3 Connect，所以本指南不涉及它。

### 原生应用还是浏览器？

|                | 手机浏览器                                          | iOS / Android 原生应用                             |
| -------------- | --------------------------------------------------- | -------------------------------------------------- |
| 它是什么       | 由你的电脑提供的 OoP Web 界面                       | 由上游项目发布的 T3 Code 移动应用（不带 OoP 品牌） |
| 安装           | 无需安装                                            | App Store / Google Play 上的 T3 Code 商店页面      |
| 连接           | 打开配对链接或扫描二维码                            | 添加环境：扫描二维码或粘贴配对 URL                 |
| 本分支是否测试 | 已按手机尺寸检查 Web 界面；尚未单独在真机上验证配对 | **否**                                             |

![通过配对链接连接的手机尺寸 Web 客户端](docs/screenshots/mobile.png)
_连接到 OoP 的手机浏览器。_

本分支保留了协议和认证标识符（见 [`UPSTREAM.json`](UPSTREAM.json) 中的 `internal_protocol_and_auth_identifiers_preserved`），因此上游应用应该可以与 OoP 服务器配对。**本分支没有测试过原生移动应用**，所以请将其视为未经确认。上游文档在 Settings → Environments 下介绍了应用的连接设置。如果出现任何异常，请改用浏览器。

### 推送通知

上游文档说，手机推送通知（智能体完成、失败、需要审批）要求登录 T3 Connect，仅使用直连或 Tailscale 连接无法启用。由于 OoP 不运营 T3 Connect，且本分支没有测试过它，**请不要指望上述路径能收到推送通知。** 请保持手机页面打开，或者稍后回来查看线程。

### 撤销设备

1. 在电脑上打开 Settings → Connections → **Authorized clients**。
2. 撤销该设备的会话以移除其现有访问权限。撤销所有未使用的配对链接，以免日后被使用。
3. 命令行：`t3 auth session list` / `t3 auth session revoke <id>`，以及 `t3 auth pairing list` / `t3 auth pairing revoke <id>`（参见 `t3 auth --help`）。
4. 若要彻底关门，请在 Settings → Connections 中关闭 **Network access**（或 **Tailscale HTTPS**）。

## 更新机制

源码构建不会从 GitHub 自动更新，请按下方步骤重新构建。若要更新二进制安装版本，请退出 OoP 并重新运行对应的安装命令。用户数据会保留。

1. `git pull`
2. 重新构建 / 打包（参见[安装](#安装--从源码构建)）并重新安装。

每个版本都以**一次提交**（标题为 `OoP <version> source`）、名为 `v<version>` 的标签和一个 GitHub Release 发布。你在 `~/.oop-desktop/userdata` 中的数据在更新后会被保留。想了解新版本，请在 GitHub 仓库上开启 **Watch → Custom → Releases**；较早的版本只有标签。

你自己构建的应用会从构建时设定的文件夹中找到你的下一次构建，并在应用内提示更新：Windows 上是上面设置的 `release\windows`，macOS 上是 `release/macos`。macOS 的 `package` 只生成 DMG，因此还需要接着构建更新包：

```bash
V=<version>
node scripts/build-oop-update-pkg.mjs --dmg release/macos/OoP-$V-arm64.dmg \
  --sha256 "$(awk '{print $1}' release/macos/OoP-$V-arm64.dmg.sha256)" \
  --version $V --output release/macos/OoP-$V-arm64-update.pkg
```

> [!NOTE]
> 应用内的服务器更新提示和 `t3 update` 来自上游 T3 Code，并不是 OoP 的更新渠道。

## 安全与隐私

> [!WARNING]
> 智能体以**你账号的权限**运行。它们可以编辑文件并运行命令。新线程的默认权限模式是 **Full access**。对于不受信任的仓库，请切换到 **Supervised**（Settings → General → New threads）。

- **ZCode** 无论你选择哪种权限模式，都会不经审批地运行自己的工具。
- **费用：** 每个提供商都使用你自己的订阅或 API 额度。Crew 在每个聊天中运行多个模型，会成倍增加用量。Usage 页面显示的是估算值，不是你的账单。
- **API 密钥**保存在服务器端，也就是你的机器上。Antigravity 的 Gemini API 密钥在设置中以**明文**保存。
- **切勿提交 `.env` 文件或密钥**，也不要把它们粘贴到 issue 或日志中。
- **上游安装程序安装的是 T3 Code，而不是 OoP：** `t3.codes` 的安装脚本、`npx t3`、Homebrew `t3-code`、winget `T3Tools.T3Code`，以及 App Store / Play 商店页面，都属于上游项目。请使用上面的 OoP 桌面安装程序，或从本仓库构建 OoP。
- **CLI 仍然叫 `t3`**，可能与上游的安装冲突。
- **源码构建产物是临时签名的**，没有 Developer ID，也未经公证。二进制安装程序会验证 SHA-256，不会绕过 Gatekeeper 隔离属性或 SmartScreen。
- **本地文件夹更新器**信任任何能写入更新文件夹的人；它的 SHA-256 校验只能检测数据损坏。

**遥测。** OoP 没有服务器，维护者不会从你的应用收到任何内容。继承自上游的服务器代码中包含一个匿名的 PostHog 使用情况上报器（使用上游项目的密钥和 `us.i.posthog.com`）；OoP **默认将其关闭**，因此除非你主动开启，否则不会发送任何数据。如需开启，请在服务器启动前在其环境中设置 `T3CODE_TELEMETRY_ENABLED=true`（参见 [`docs/user/telemetry.md`](docs/user/telemetry.md)）。开启后，事件涵盖提供商、模型、推理强度、权限模式、轮次结果、耗时以及主智能体的 token 总量，并与经过哈希的账号或安装标识符关联；据文档所述，其中绝不包含提示词、响应、文件内容、认证令牌或对话 ID。

如需报告安全漏洞，请参见 [SECURITY.md](SECURITY.md)。

## 常见问题 / 故障排查

**macOS 提示无法打开源码构建的应用，或来自身份不明的开发者。**
源码构建是临时签名且未经公证的。右键点击应用并选择 **Open**，或前往“系统设置” → “隐私与安全性” → **Open Anyway**。二进制安装程序不会绕过隔离属性。

**Windows 对源码构建的安装程序显示 SmartScreen 警告。**
源码构建的安装程序未签名。二进制安装程序不会绕过 SmartScreen。

**某个提供商显示“not signed in”。**
使用该提供商自己的命令登录（参见[支持的提供商](#支持的提供商)），然后重新打开 Settings → Providers。该 CLI 必须位于运行服务器那台机器的 `PATH` 中。源代码管理账号在 Settings → Source Control 中有 **Rescan** 按钮。

**我的手机连不上服务器。**

- 检查网络访问是否已开启（Connect mobile → **Allow mobile connections**，或 Settings → Connections → **Network access**）。
- 确保配对链接不是 `127.0.0.1` / localhost 地址。
- 手机和电脑必须在同一网络（局域网）或同一个 tailnet 中；访客 Wi-Fi 通常会阻止设备之间的流量。
- 配对链接是一次性且有效期很短的；请重新创建一个。
- 检查两台设备的日期和时间，并确认电脑处于唤醒状态。

**`node scripts/macos.mjs doctor` 抱怨 Node 版本。**
你需要 Node.js 24.x（24.13.1 或更高版本）和 pnpm 11.10.0。其他 Node 主版本会被拒绝。

**我的数据在哪里？**
OoP 的服务器状态（线程、设置、本地数据库）位于 `~/.oop-desktop/userdata`。桌面二进制程序与这些数据分开安装。提供商的登录信息保存在各提供商 CLI 自己的文件夹中，不在这里。

**如何更新二进制安装版本？**
退出 OoP，然后重新运行对应的安装命令。用户数据会保留。

**如何重置 OoP？**
退出应用，然后把 `~/.oop-desktop/userdata` 移到一边（在确定之前不要删除）。OoP 下次启动时会是全新状态。你的项目文件夹不会受影响。

**如何卸载？**
退出应用，然后删除 `~/Applications/OoP.app`（macOS；或 `OOP_INSTALL_DIR` 指定的路径），在 Windows 设置中卸载 OoP，或在 Linux 上删除 `~/.local/bin/oop-desktop`、`~/.local/share/oop-desktop` 和桌面菜单项。也可以删除 `~/.oop-desktop` 来清除它的数据。提供商 CLI 是单独安装的，不会被移除。

**这会花我的钱吗？**
OoP 本身免费。它所运行的提供商使用你自己的订阅或 API 额度。Crew 在每个聊天中使用多个模型，Usage 页面显示的是估算（而非实际计费）的费用。

**我能使用上游的 T3 Code 移动应用吗？**
它应该可以配对，但本分支没有测试过。参见[原生应用还是浏览器](#原生应用还是浏览器)。

## 仓库结构

| 路径                                         | 内容                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `apps/server`                                | Node WebSocket 服务器：编排、提供商、检查点、`t3` CLI                 |
| `apps/web`                                   | React / Vite 界面                                                     |
| `apps/desktop`                               | 封装 Web 界面并内置服务器的 Electron 外壳                             |
| `apps/mobile`                                | React Native 客户端（上游应用代码）                                   |
| `packages/contracts`                         | 所有跨线路数据的类型化模式                                            |
| `packages/shared`、`packages/client-runtime` | 共享的运行时工具，以及 Web 与移动端共用的客户端代码                   |
| `infra/oop-relay`                            | 可选的 Cloudflare 中继 Worker                                         |
| `docs/`                                      | `user/` 用户指南、`internals/` 架构笔记、`operations/` 安装与发布说明 |

关于代码库的组织方式及其遵循的约定，参见 [`AGENTS.md`](AGENTS.md)。

## 状态与路线图说明

OoP 尚处于**早期**。难免有 bug。本分支实际测试过的平台只有 macOS Apple Silicon；Windows 是实验性的；Intel Mac、Linux、原生移动应用、推送通知以及付费的 Z.AI / MiniMax 请求均未测试。没有承诺的路线图：维护者修复自己遇到的问题，并在准备就绪时发布新版本。

## 贡献

本仓库是一个**发布镜像**。欢迎提交 issue。拉取请求会在维护者的代码树中审查并重新应用到上游，所以公开历史是每个版本一次提交。参见 [CONTRIBUTING.md](CONTRIBUTING.md)。切勿在 issue 中包含密钥、配对 URL 或个人路径。

## 许可证与致谢

[MIT](LICENSE)。必须保留原始声明“Copyright (c) 2026 T3 Tools Inc.”，本分支的修改同样采用 MIT 许可。

OoP 构建于 T3 Tools Inc. 和 pingdotgg 团队的 [T3 Code](https://github.com/pingdotgg/t3code) 之上。提供商名称（Codex、Claude Code、Cursor、Grok、OpenCode、Antigravity、ZCode、MiniMax、Z.AI）归其各自所有者所有；OoP 与它们没有关联。
