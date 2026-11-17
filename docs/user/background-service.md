# Running OOP in the background

On Linux and macOS, OOP can run as a service for your user so you do not need
to keep a terminal open.

## Install and update

In the desktop app, open **Settings → Connections → SSH** and connect to the
host. OOP installs and starts the background service there. When a newer desktop
app reconnects, it updates the service to its version. See [Updating OOP](./updating.md).

## Manage the service

To manage the service from a terminal, install the [OOP terminal app](./install.md#terminal-app)
on the host, then run these commands there:

| Task                            | Command                        |
| ------------------------------- | ------------------------------ |
| Inspect status and log location | `oop server service status`    |
| Restart                         | `oop server service restart`   |
| Stop and remove from startup    | `oop server service uninstall` |

Restarting interrupts running agent turns, terminals, and remote clients.
Uninstalling the service leaves your projects, threads, and settings intact in
`~/.oop-desktop/userdata`. Reconnect through the desktop app's SSH connection to
set up the service again. For removing OOP itself, see [Install OOP](./install.md).

## Platform support

Linux needs systemd user services. Setup enables lingering so OOP starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

OOP Connect does not install the service. Signing out of OOP Connect does not
stop or uninstall it.

## Troubleshooting

Start with `oop server service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then reconnect through the desktop app's SSH connection. Run only the `loginctl` command
with sudo; running OOP as root creates a separate installation and Connect
identity. Without administrator access, run `oop server serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status t3code.service`, then reconnect through the desktop app's SSH connection.            |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `oop server service restart`.                    |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after signing in to OOP Connect, see
[connection troubleshooting](./remote-access.md#oop-connect-troubleshooting).
