import test from "node:test";
import assert from "node:assert/strict";
import { ActionQueue } from "../src/shared/action-queue";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("FIFO 串行执行，并只在执行函数完成后报告 executed", async () => {
  const queue = new ActionQueue<string>();
  const events: string[] = [];
  let release!: () => void;
  const firstDone = new Promise<void>((resolve) => { release = resolve; });
  queue.enqueue({ value: "first", execute: () => firstDone, onResult: (s) => events.push(`first:${s}`) });
  queue.enqueue({ value: "second", execute: async () => { events.push("second:run"); }, onResult: (s) => events.push(`second:${s}`) });
  await flush();
  assert.deepEqual(events, ["first:queued", "second:queued"]);
  release();
  await flush();
  assert.deepEqual(events, ["first:queued", "second:queued", "first:executed", "second:run", "second:executed"]);
});

test("实际执行前二次检查可阻止已排队动作", async () => {
  const queue = new ActionQueue<string>();
  const states: string[] = [];
  let called = false;
  queue.enqueue({ value: "targeted", beforeExecute: () => "target-changed", execute: async () => { called = true; }, onResult: (s, r) => states.push(`${s}:${r || ""}`) });
  await flush();
  assert.equal(called, false);
  assert.deepEqual(states, ["queued:", "blocked:target-changed"]);
});

test("执行异常和队列溢出都返回明确 failed", async () => {
  const queue = new ActionQueue<string>(1);
  const first: string[] = [];
  const second: string[] = [];
  const third: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  queue.enqueue({ value: "slow", execute: () => pending, onResult: (s, r) => first.push(`${s}:${r || ""}`) });
  queue.enqueue({ value: "waiting", execute: async () => {}, onResult: (s, r) => second.push(`${s}:${r || ""}`) });
  queue.enqueue({ value: "overflow", execute: async () => {}, onResult: (s, r) => third.push(`${s}:${r || ""}`) });
  assert.deepEqual(third, ["failed:queue-full"]);
  release();
  await flush();
  assert.deepEqual(first, ["queued:", "executed:"]);
  assert.deepEqual(second, ["queued:", "executed:"]);

  const failed: string[] = [];
  queue.enqueue({ value: "throws", execute: async () => { throw new Error("do not leak"); }, onResult: (s, r) => failed.push(`${s}:${r || ""}`) });
  await flush();
  assert.deepEqual(failed, ["queued:", "failed:execution-error"]);
});
