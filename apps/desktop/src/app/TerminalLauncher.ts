/**
 * The `oop` command OOP Desktop writes for a macOS app, kept free of Electron and Effect imports so
 * that the installer tests can compare it with scripts/install-desktop.sh, which writes the same text.
 */

/** Second line of every launcher OOP Desktop writes; install-desktop.sh uses the same mark. */
export const LAUNCHER_MARK = "oop-desktop-terminal-launcher";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The `oop` command for the app at `appBundle`, byte for byte what install-desktop.sh writes (a
 * test compares the two): it runs the app's Rust client (oop-rs), the only terminal, and says with
 * OOP_IN_DESKTOP_APP=1 that it is the app's own. It looks for the app again at every start, so
 * moving it does not break it.
 */
export const terminalLauncherScript = (appBundle: string) =>
  `#!/bin/sh
# ${LAUNCHER_MARK} (written by OOP Desktop install-desktop.sh; safe to delete)
for app in ${shellQuote(appBundle)} "$HOME/Applications/OOP.app" /Applications/OOP.app; do
  res="$app/Contents/Resources/oop"
  if [ -x "$app/Contents/MacOS/OOP" ] && [ -x "$res/oop-rs" ]; then
    OOP_IN_DESKTOP_APP=1
    export OOP_IN_DESKTOP_APP
    exec "$res/oop-rs" "$@"
  fi
done
echo "oop: OOP.app was not found, or it is too old to include the terminal app. Install or update OOP Desktop." >&2
exit 127
`;

/** True for a regular file whose second line is our mark, i.e. a launcher OOP Desktop wrote. */
export const isOurLauncher = (text: string) => {
  const lines = text.split("\n", 3);
  return (
    lines[0] === "#!/bin/sh" &&
    (lines[1] === `# ${LAUNCHER_MARK}` || (lines[1] ?? "").startsWith(`# ${LAUNCHER_MARK} `))
  );
};
