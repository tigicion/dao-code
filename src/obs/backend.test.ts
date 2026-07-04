import { describe, it, expect, beforeEach, vi } from "vitest";
import { setBackend, getBackend, isObsOn, flushObs, setObsSession, getObsSession, setObsStatus, obsStatus } from "./backend.js";
import type { ObsBackend } from "./backend.js";

const fake: ObsBackend = {
  startSpan: () => ({ setAttributes() {}, end() {} }),
  withActive: (_s, fn) => fn(),
  flush: async () => {},
};

describe("backend 单例", () => {
  beforeEach(() => setBackend(null));
  it("默认关闭:getBackend null、isObsOn false", () => {
    expect(getBackend()).toBeNull();
    expect(isObsOn()).toBe(false);
  });
  it("setBackend 后开启", () => {
    setBackend(fake);
    expect(getBackend()).toBe(fake);
    expect(isObsOn()).toBe(true);
  });
});

describe("obs session id", () => {
  beforeEach(() => setObsSession(undefined));
  it("默认无 session id", () => {
    expect(getObsSession()).toBeUndefined();
  });
  it("set 后 get 拿到", () => {
    setObsSession("20260704-093759-qse2");
    expect(getObsSession()).toBe("20260704-093759-qse2");
  });
});

describe("obs status", () => {
  beforeEach(() => { setBackend(null); setObsStatus({ requested: false, endpoint: undefined }); });
  it("未请求:requested/on 均 false", () => {
    expect(obsStatus()).toEqual({ requested: false, on: false, endpoint: undefined });
  });
  it("请求但未 setBackend(降级):requested true、on false", () => {
    setObsStatus({ requested: true });
    const s = obsStatus();
    expect(s.requested).toBe(true);
    expect(s.on).toBe(false);
  });
  it("请求且 setBackend + endpoint:on true、带 endpoint", () => {
    setObsStatus({ requested: true, endpoint: "localhost:8001" });
    setBackend(fake);
    expect(obsStatus()).toEqual({ requested: true, on: true, endpoint: "localhost:8001" });
  });
});

describe("flushObs 退出旁路", () => {
  beforeEach(() => setBackend(null));

  it("未 setBackend 时立即 resolve 且不抛", async () => {
    await expect(flushObs()).resolves.toBeUndefined();
  });

  it("已开启时 flush 被调用一次", async () => {
    const flush = vi.fn(async () => {});
    setBackend({ ...fake, flush });
    await flushObs();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flush 永不 resolve 时仍能在超时后 resolve(不挂死)", async () => {
    const flush = vi.fn(() => new Promise<void>(() => {})); // 永不 resolve
    setBackend({ ...fake, flush });
    // 注入较短超时,避免真等 2s
    await expect(flushObs(10)).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
