import test from "node:test";
import assert from "node:assert/strict";
import { HoldController, type HoldIdentity } from "../src/shared/hold-controller";

const hold = (interactionId = "interaction-a", clientId = "phone-a", buttonId = "voice"): HoldIdentity => ({
  clientId, interactionId, buttonId,
});

test("begin/end 建立并释放单一保持，重复包幂等", async () => {
  const events: string[] = [];
  const controller = new HoldController({
    begin: async (h) => { events.push(`begin:${h.interactionId}`); },
    release: async (h, reason) => { events.push(`release:${h.interactionId}:${reason}`); },
  });
  assert.deepEqual(await controller.begin(hold()), { status: "holding" });
  assert.deepEqual(await controller.begin(hold()), { status: "holding" });
  assert.deepEqual(await controller.end(hold()), { status: "released" });
  assert.deepEqual(await controller.end(hold()), { status: "released" });
  assert.deepEqual(await controller.begin(hold()), { status: "released" });
  assert.deepEqual(events, ["begin:interaction-a", "release:interaction-a:end"]);
});

test("活动保持拒绝第二会话，并保护 owner 和按钮身份", async () => {
  let releases = 0;
  const controller = new HoldController({ begin: async () => {}, release: async () => { releases++; } });
  await controller.begin(hold());
  assert.deepEqual(await controller.begin(hold("interaction-b")), { status: "failed", reason: "hold-busy" });
  assert.deepEqual(await controller.end(hold("interaction-a", "phone-b")), { status: "failed", reason: "interaction-owner-mismatch" });
  assert.deepEqual(await controller.end(hold("interaction-a", "phone-a", "send")), { status: "failed", reason: "interaction-conflict" });
  assert.equal(releases, 0);
  assert.deepEqual(await controller.end(hold()), { status: "released" });
});

test("begin 和 release 异常脱敏，release 失败仍清理活动状态并留 tombstone", async () => {
  const beginFailure = new HoldController({ begin: async () => { throw new Error("secret"); }, release: async () => {} });
  assert.deepEqual(await beginFailure.begin(hold()), { status: "failed", reason: "begin-error" });
  assert.equal(beginFailure.activeHold, null);

  const releaseFailure = new HoldController({ begin: async () => {}, release: async () => { throw new Error("secret"); } });
  await releaseFailure.begin(hold());
  assert.deepEqual(await releaseFailure.end(hold()), { status: "failed", reason: "release-error" });
  assert.equal(releaseFailure.activeHold, null);
  assert.deepEqual(await releaseFailure.begin(hold()), { status: "released" });
});

test("releaseClient 只释放所属设备，releaseAll 可处理 Host 停止", async () => {
  const reasons: string[] = [];
  const controller = new HoldController({ begin: async () => {}, release: async (_h, reason) => { reasons.push(reason); } });
  await controller.begin(hold());
  assert.equal(await controller.releaseClient("phone-b"), null);
  assert.deepEqual(await controller.releaseClient("phone-a"), { status: "released" });
  await controller.begin(hold("interaction-b"));
  assert.deepEqual(await controller.releaseAll("host-stop"), { status: "released" });
  assert.deepEqual(reasons, ["disconnect", "host-stop"]);
});

test("watchdog 自动释放并阻止迟到 begin 复活", async () => {
  let automatic: string | undefined;
  let releases = 0;
  const controller = new HoldController({
    watchdogMs: 10,
    begin: async () => {},
    release: async () => { releases++; },
    onAutomaticRelease: (_h, result, reason) => { automatic = `${result.status}:${reason}`; },
  });
  await controller.begin(hold());
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(controller.activeHold, null);
  assert.equal(releases, 1);
  assert.equal(automatic, "released:watchdog");
  assert.deepEqual(await controller.begin(hold()), { status: "released" });
});

test("并发 begin 被串行化，不会同时建立两个保持", async () => {
  let begins = 0;
  const controller = new HoldController({
    begin: async () => { begins++; await new Promise((resolve) => setTimeout(resolve, 5)); },
    release: async () => {},
  });
  const [first, second] = await Promise.all([controller.begin(hold()), controller.begin(hold("interaction-b"))]);
  assert.deepEqual(first, { status: "holding" });
  assert.deepEqual(second, { status: "failed", reason: "hold-busy" });
  assert.equal(begins, 1);
  await controller.releaseAll();
});
