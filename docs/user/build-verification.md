# Verify a macOS release build

Open the server thread for the project, then select **Verify macOS build** in the chat header. On a narrow window, find it under **More header actions**. The control appears when the connected server supports verification on macOS with Apple Silicon. It works for a remote server; the checks run on that server's Mac.

Prepare the build in the thread's worktree, or in the project's root if the thread has no worktree. Put `OOP_RELEASE.json` at that root with a numeric three-part version, for example:

```json
{ "version": "1.2.3" }
```

Put the matching disk image at `release/macos/OOP-1.2.3-arm64.dmg`. The server selects this file from the version in `OOP_RELEASE.json`; the panel does not accept another path or an imported result.

Select **Verify macOS build** in the panel to start. Verification opens a temporary app window **on the server Mac**, even if you are using OOP remotely. The panel shows the current attempt, its six checks, and any reasons a result needs attention. Use **Cancel verification** during a running attempt; it waits for the server to stop and record the result.

**Verified** means the disk image passed integrity and strict code-signature checks, the app passed the startup check (it runs with its own data folders, but uses the server Mac's real keychain and per-user settings, so this is not a sandbox), and the server found the file content unchanged when it last checked. Select **Refresh** to check the current file again; the panel does not watch it continuously. **Failed** means a check observed a failure. **Needs confirmation** means verification is incomplete or could not establish the result, including a timeout, cancellation, interruption, missing check, changed file, or a file that could not be rechecked. Read the check details and reasons before retrying.

This verifies the OOP macOS release image for this thread. It does not verify arbitrary agent work, the full UI or features, Gatekeeper approval, or notarization.
