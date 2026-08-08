import assert from "node:assert/strict";
import test from "node:test";
import { matchTarget, validateButton } from "../src/shared/config-resolve";

test("目标规则在匹配、失配和前台探测失败时给出安全结果", () => {
  const target = { process: "^notepad\\.exe$", title: "TouchDeck QA" };
  assert.equal(matchTarget(target, { process: "NOTEPAD.EXE", title: "TouchDeck QA - Notepad" }), true);
  assert.equal(matchTarget(target, { process: "explorer.exe", title: "TouchDeck QA - Notepad" }), false);
  assert.equal(matchTarget(target, null), false);
});

test("无效目标正则会被配置校验剔除，遗留错误配置也不会放行", () => {
  const errors: string[] = [];
  const result = validateButton({ id: "bad-target", keys: { ctrl: "a" }, target: { process: "[" } }, "buttons[0]", errors);
  assert.equal(result, null);
  assert.match(errors[0], /不是有效正则/);
  assert.equal(matchTarget({ process: "[" }, { process: "notepad.exe", title: "QA" }), false);
});
