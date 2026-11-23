import {
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "@t3tools/client-runtime/markdown-links";
import { composerMentionFromTreePath } from "./chat/composerMentionDrag";

export function fileLinkContextMention(
  targetPath: string,
  workspaceRoot: string | undefined,
): string | null {
  const { path } = splitFilePathPosition(targetPath);
  const relativePath = workspaceRelativeFilePath(path, workspaceRoot);
  if (!relativePath || relativePath.split(/[\\/]/).includes("..")) return null;
  return composerMentionFromTreePath(relativePath);
}
