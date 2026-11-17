# Updating OOP

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## See what's new

After an update, OOP shows a "What's new" card over the startup screen once.
Close it and it stays away until the next update. Choose **See all updates** to
open **Settings → What's new**, which lists the highlights of every release and
marks the version you are running. A dot next to **What's new** shows until you
open that page after an update.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
OOP must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
Threads interrupted while a tool was running or while waiting for your answer, or
whose recent activity cannot be checked, are not resumed automatically; check the
workspace, then send a message to continue.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Stop the command-line server on its host and relaunch with the copied command, keeping your usual startup options.                                                                              |

For a desktop-hosted server, update the desktop app on the host. macOS and
Windows update automatically; on Linux, follow [the installation instructions](./install.md#desktop-app).
For an SSH host, reconnect from the newer desktop app to update its background
service. See [Running OOP in the background](./background-service.md).

For the terminal app, run `oop update` and follow its instructions. If you started
a server by hand, stop it and run `oop server serve` again with your usual options
such as `--host` or `--tailscale-serve` after updating.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and update the OOP terminal app and relaunch the server.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** checks for an available update. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions.

The React Native app installs App Store or Google Play releases and downloads
updates in the background. That app is no longer the supported phone surface; on
the relay mobile web, reload the page to get the current web app.
