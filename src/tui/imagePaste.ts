// 剪贴板图片读取(macOS 用 osascript)。Linux/Windows 预留但不实现。
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

/** 从剪贴板读取 PNG 图片，返回 base64 + mediaType。无图片或失败返回 null。 */
export async function getImageFromClipboard(): Promise<{ base64: string; mediaType: string } | null> {
  if (process.platform !== "darwin") return null;
  const tmpPath = `/tmp/dao_paste_${Date.now()}.png`;
  try {
    // 先检查剪贴板是否有 PNG 图片
    const check = execFileSync("osascript", ["-e", "the clipboard as «class PNGf»"], { timeout: 5000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!check || check === "missing value") return null;
    // 写到临时文件
    execFileSync("osascript", [
      "-e", "set png_data to (the clipboard as «class PNGf»)",
      "-e", `set fp to open for access POSIX file "${tmpPath}" with write permission`,
      "-e", "write png_data to fp",
      "-e", "close access fp",
    ], { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    const buf = await readFile(tmpPath);
    if (buf.length === 0) return null;
    if (buf.length > 5 * 1024 * 1024) return null; // 5MB 护栏
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch {
    return null;
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}
