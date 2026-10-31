import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { hostPlatform } from "../host.ts";
import { originsMatch } from "./selectCredential.ts";

export interface StoredCredential {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly token: string;
  readonly savedAt: string;
}

interface CredentialFile {
  readonly version: 1;
  readonly environments: Record<string, StoredCredential>;
}

const isCredential = (value: unknown): value is StoredCredential => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.environmentId === "string" &&
    typeof record.label === "string" &&
    typeof record.httpBaseUrl === "string" &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.savedAt === "string"
  );
};

/**
 * Entries are keyed by environment id and address. `save` already removes every entry the new one
 * replaces (the same server at any loopback address), so the key only has to be unique. Files from
 * before this carry the bare environment id as key; lookups go by the values, so they keep working
 * and are replaced entry by entry as the same address is saved again.
 */
const entryKey = ({ environmentId, httpBaseUrl }: StoredCredential): string =>
  `${environmentId} ${httpBaseUrl}`;

const newest = (entries: readonly StoredCredential[]): StoredCredential | null =>
  entries.reduce<StoredCredential | null>(
    (best, entry) => (best === null || entry.savedAt > best.savedAt ? entry : best),
    null,
  );

/** The file exists but cannot be read as credentials; it is left alone so nothing in it is lost. */
export class CredentialFileError extends Error {
  constructor(filePath: string, reason: string) {
    super(
      `자격증명 파일이 손상되었습니다 (${reason}): ${filePath}\n파일을 확인하거나 지운 뒤 'oop pair <링크>' 로 다시 연결하세요.`,
    );
    this.name = "CredentialFileError";
  }
}

/** Entries that are not credentials are dropped; a file that is not a credential file throws. */
export const parseCredentialFile = (
  text: string,
  filePath = "credentials.json",
): CredentialFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialFileError(filePath, "JSON이 아님");
  }
  const environments =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).environments
      : undefined;
  if (environments === null || typeof environments !== "object") {
    throw new CredentialFileError(filePath, "형식이 다름");
  }
  const kept: Record<string, StoredCredential> = {};
  for (const [key, value] of Object.entries(environments)) {
    if (isCredential(value)) kept[key] = value;
  }
  return { version: 1, environments: kept };
};

/** A token file: private directory, private file, replaced atomically so a crash never truncates it. */
export class CredentialStore {
  private readonly filePath: string;
  private readonly platform: NodeJS.Platform;

  constructor(filePath: string, platform: NodeJS.Platform = hostPlatform()) {
    this.filePath = filePath;
    this.platform = platform;
  }

  /** A missing file is an empty store; any other trouble is an error rather than a silent reset. */
  private async read(): Promise<CredentialFile> {
    let text: string;
    try {
      text = await NodeFSP.readFile(this.filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, environments: {} };
      }
      throw cause;
    }
    await this.tighten();
    return parseCredentialFile(text, this.filePath);
  }

  /** A file left readable by others (an older version, a copy, a restore) is closed up when it is read. */
  private async tighten(): Promise<void> {
    if (this.platform === "win32") return;
    try {
      const { mode } = await NodeFSP.stat(this.filePath);
      if ((mode & 0o077) !== 0) await NodeFSP.chmod(this.filePath, 0o600);
    } catch {
      // Reading worked; failing to tighten (not our file, read-only mount) must not lock the user out.
    }
  }

  /** Throws if the file is there but unusable; call it before spending a one-time pairing token. */
  async verify(): Promise<void> {
    await this.read();
  }

  /** The credential saved for this server at this address; one for another address is not returned. */
  async find(environmentId: string, origin: string): Promise<StoredCredential | null> {
    const { environments } = await this.read();
    return newest(
      Object.values(environments).filter(
        (entry) => entry.environmentId === environmentId && originsMatch(entry.httpBaseUrl, origin),
      ),
    );
  }

  /** Where else this server is saved (the newest address), for telling the user; never a token. */
  async savedAddress(environmentId: string): Promise<string | null> {
    const { environments } = await this.read();
    return (
      newest(Object.values(environments).filter((entry) => entry.environmentId === environmentId))
        ?.httpBaseUrl ?? null
    );
  }

  async save(credential: StoredCredential): Promise<void> {
    const current = await this.read();
    const environments: Record<string, StoredCredential> = {};
    for (const [key, entry] of Object.entries(current.environments)) {
      const replaced =
        entry.environmentId === credential.environmentId &&
        originsMatch(entry.httpBaseUrl, credential.httpBaseUrl);
      if (!replaced) environments[key] = entry;
    }
    environments[entryKey(credential)] = credential;
    const next: CredentialFile = { version: 1, environments };
    const directory = NodePath.dirname(this.filePath);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    // An older, looser directory is tightened before any token is written into it.
    if (this.platform !== "win32") await NodeFSP.chmod(directory, 0o700);
    // `wx` never follows or reuses an existing path, and the name cannot be guessed in advance.
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await NodeFSP.rename(temporary, this.filePath);
    } catch (cause) {
      await NodeFSP.rm(temporary, { force: true });
      throw cause;
    }
    if (this.platform !== "win32") await NodeFSP.chmod(this.filePath, 0o600);
  }
}
