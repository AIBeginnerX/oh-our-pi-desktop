# Product usage data and network requests

## Product usage data

OOP does not report product usage, and it ships without an analytics project key.

To opt in, set both of these in the server's environment before starting it:

- `T3CODE_TELEMETRY_ENABLED=true`
- `T3CODE_POSTHOG_KEY` to your own PostHog project key. `T3CODE_POSTHOG_HOST` selects the PostHog
  host and defaults to `https://us.i.posthog.com`.

If either is missing, nothing is sent.

When enabled, the server sends product usage events to that PostHog project, associated with a
hashed account or installation identifier. Events include the provider, model, reasoning effort,
permission mode, turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

## Agent CLI telemetry

Agent CLIs can report their own usage to their vendors. Each provider that supports it has a
telemetry switch in **Settings → Providers**:

| Provider    | Switch                | Default | When the switch is off                                                                 |
| ----------- | --------------------- | ------- | -------------------------------------------------------------------------------------- |
| Claude Code | Claude Code telemetry | On      | `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`                                  |
| Codex       | Codex analytics       | Off     | `-c analytics.enabled=false`, unless your `config.toml` or launch arguments set it     |
| Grok        | Grok telemetry        | Off     | `GROK_TELEMETRY_ENABLED=false`, `DISABLE_TELEMETRY=1`, and `DISABLE_ERROR_REPORTING=1` |
| ZCode       | ZCode telemetry       | Off     | `ZCODE_MODEL_TELEMETRY_ENABLED=false`                                                  |

Claude Code stays on by default because turning its telemetry off also turns off the feature flags
that features such as Remote Control use. When a switch is on, OOP leaves that CLI's own reporting
settings alone.

A value you set yourself, in the server's environment or in a provider instance's environment,
always wins over the switch.

The other providers have no switch OOP can set:

- **Cursor:** reporting follows your Cursor account's privacy mode. Change it in Cursor's settings.
- **MiniMax Code:** it sends usage events to MiniMax and offers no setting to turn them off.
- **Antigravity:** it has no telemetry setting of its own. Your Google account settings apply.
- **OpenCode:** it does not report usage on its own.

## Other network requests

Apart from your agents' own traffic, OOP makes these requests on its own:

- **Link icons.** Icons for links and websites in the chat load from Google's favicon service and
  from the sites themselves. To use generic icons instead, turn off **Settings → Appearance → Load
  link icons from Google**. On mobile, the switch is in Settings → Appearance.
- **Images in responses.** Images that an agent links in its response load from where they are
  hosted.
- **Provider update checks.** OOP checks GitHub and the npm registry for newer agent CLI versions.
  Turn this off with **Settings → General → Provider update checks**.
- **Usage pricing.** Opening usage views downloads a public model price list from GitHub.
