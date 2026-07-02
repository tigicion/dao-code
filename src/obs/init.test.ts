import { describe, it, expect, beforeEach } from "vitest";
import { initObs } from "./init.js";
import { isObsOn, setBackend } from "./backend.js";

describe("initObs 关闭路径", () => {
  beforeEach(() => setBackend(null));
  it("on=false 时不开启后端(也不 import lmnr)", async () => {
    await initObs(false);
    expect(isObsOn()).toBe(false);
  });
});
