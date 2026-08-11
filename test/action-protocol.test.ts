import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_PROTOCOL_VERSION, RequestLedger, actionResult, parseActionRequest } from "../src/shared/action-protocol";

const requestId = "a0d3fcb4-1e4e-4d3f-9876-5c8a5d4b9c01";

test("只接受版本化且格式合法的远程动作", () => {
  assert.deepEqual(parseActionRequest({ v: ACTION_PROTOCOL_VERSION, type: "action", requestId, buttonId: "send" }), {
    v: 1, type: "action", requestId, buttonId: "send",
  });
  assert.equal(parseActionRequest({ id: "send" }), null);
  assert.equal(parseActionRequest({ v: 1, type: "action", requestId: "bad", buttonId: "send" }), null);
  assert.equal(parseActionRequest({ v: 1, type: "action", requestId, buttonId: "../paste" }), null);
});

test("保持动作以 phase 和 interactionId 成对扩展，同时兼容旧 tap", () => {
  const interactionId = "d0d3fcb4-1e4e-4d3f-9876-5c8a5d4b9c04";
  assert.deepEqual(parseActionRequest({
    v: 1, type: "action", requestId, buttonId: "voice", phase: "begin", interactionId,
  }), {
    v: 1, type: "action", requestId, buttonId: "voice", phase: "begin", interactionId,
  });
  assert.equal(parseActionRequest({ v: 1, type: "action", requestId, buttonId: "voice", phase: "begin" }), null);
  assert.equal(parseActionRequest({ v: 1, type: "action", requestId, buttonId: "voice", interactionId }), null);
  assert.equal(parseActionRequest({ v: 1, type: "action", requestId, buttonId: "voice", phase: "start", interactionId }), null);
  assert.equal(parseActionRequest({ v: 1, type: "action", requestId, buttonId: "voice", phase: "end", interactionId: "bad" }), null);
});

test("保持动作结果支持 holding 和 released", () => {
  assert.equal(actionResult(requestId, "holding").status, "holding");
  assert.equal(actionResult(requestId, "released").status, "released");
});

test("幂等记录按客户端隔离，并保留最终或排队状态", () => {
  const ledger = new RequestLedger(2);
  ledger.record("phone-a", actionResult(requestId, "queued"));
  assert.equal(ledger.get("phone-a", requestId)?.status, "queued");
  ledger.record("phone-a", actionResult(requestId, "executed"));
  assert.equal(ledger.get("phone-a", requestId)?.status, "executed");
  assert.equal(ledger.get("phone-b", requestId), undefined);
});

test("有限幂等窗口淘汰最旧请求，不影响其他客户端语义", () => {
  const ledger = new RequestLedger(2);
  ledger.record("phone-a", actionResult(requestId, "queued"));
  ledger.record("phone-a", actionResult("b0d3fcb4-1e4e-4d3f-9876-5c8a5d4b9c02", "blocked", "target-changed"));
  ledger.record("phone-b", actionResult("c0d3fcb4-1e4e-4d3f-9876-5c8a5d4b9c03", "failed", "queue-full"));
  assert.equal(ledger.get("phone-a", requestId), undefined);
  assert.equal(ledger.get("phone-b", "c0d3fcb4-1e4e-4d3f-9876-5c8a5d4b9c03")?.status, "failed");
});
