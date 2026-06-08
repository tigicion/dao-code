import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os";
import { resolveInWorkspace } from "./paths.js";

const root = path.resolve("/tmp/ws");

describe("resolveInWorkspace", () => {
  it("resolves a relative path inside the workspace", () => {
    expect(resolveInWorkspace(root, "a.txt")).toBe(path.join(root, "a.txt"));
    expect(resolveInWorkspace(root, "sub/b.txt")).toBe(path.join(root, "sub", "b.txt"));
  });

  it("allows the workspace root itself", () => {
    expect(resolveInWorkspace(root, ".")).toBe(root);
  });

  it("normalizes harmless .. that stays inside", () => {
    expect(resolveInWorkspace(root, "sub/../a.txt")).toBe(path.join(root, "a.txt"));
  });

  it("rejects traversal escaping the workspace", () => {
    expect(() => resolveInWorkspace(root, "../etc/passwd")).toThrow(/越界/);
    expect(() => resolveInWorkspace(root, "sub/../../x")).toThrow(/越界/);
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(/越界/);
  });

  it("拒绝经区内符号链接逃逸到区外(M8)", () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dao-sym-")));
    const ws = path.join(base, "ws");
    const outside = path.join(base, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "x");
    symlinkSync(outside, path.join(ws, "link")); // ws/link → ../outside
    expect(() => resolveInWorkspace(ws, "link/secret.txt")).toThrow(/逃逸|越界/);
  });
});
