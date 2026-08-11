import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingTapCount,
  canonicalKeyCombo,
  defaultActionBindings,
  findBindingConflicts,
  normalizeKeyCombo,
  validateActionBindings,
} from "../src/shared/action-bindings";

test("defaults lock voice to Codex hold and esc/enter to tap", () => {
  const defaults = defaultActionBindings();
  assert.deepEqual(defaults.bindings.voice, {
    presetId: "codex-dictation",
    keys: { ctrl: true, shift: true, key: "d" },
    triggerMode: "hold",
  });
  assert.equal(defaults.bindings.esc.triggerMode, "tap");
  assert.equal(bindingTapCount("esc", defaults.bindings.esc), 2);
  assert.equal(defaults.bindings.enter.triggerMode, "tap");
  assert.equal(bindingTapCount("enter", defaults.bindings.enter), 1);
});

test("Codex interrupt repeats only for the recommended preset", () => {
  assert.equal(bindingTapCount("esc", { presetId: "custom", keys: { key: "escape" }, triggerMode: "tap" }), 1);
  assert.equal(bindingTapCount("esc", { presetId: "recommended", keys: { key: "escape" }, triggerMode: "hold" }), 1);
});

test("strict validation accepts custom modifiers and rejects extra fields", () => {
  const custom = defaultActionBindings();
  custom.bindings.voice = { presetId: "custom", keys: { ctrl: true, win: true, shift: true }, triggerMode: "tap" };
  assert.deepEqual(validateActionBindings(custom), custom);
  assert.equal(validateActionBindings({ ...custom, extra: true }), null);
  assert.equal(validateActionBindings({ ...custom, schemaVersion: 2 }), null);
  assert.equal(validateActionBindings({ ...custom, bindings: { voice: custom.bindings.voice } }), null);
});

test("known preset id cannot be paired with altered keys or mode", () => {
  const altered = defaultActionBindings();
  altered.bindings.voice.keys = { win: true, key: "h" };
  assert.equal(validateActionBindings(altered), null);
  altered.bindings.voice = { presetId: "codex-dictation", keys: { ctrl: true, shift: true, key: "d" }, triggerMode: "tap" };
  assert.equal(validateActionBindings(altered), null);
});

test("key combos normalize casing and reject unsupported/text/empty input", () => {
  assert.deepEqual(normalizeKeyCombo({ ctrl: true, shift: false, key: " D " }), { ctrl: true, key: "d" });
  assert.equal(normalizeKeyCombo({ text: "unsafe" }), null);
  assert.equal(normalizeKeyCombo({ key: ";" }), null);
  assert.equal(normalizeKeyCombo({}), null);
  assert.equal(canonicalKeyCombo({ win: true, ctrl: true, key: "h" }), "ctrl+win+h");
});

test("canonical conflict detection catches reordered and false modifiers", () => {
  const bindings = defaultActionBindings().bindings;
  bindings.enter = { presetId: "custom", keys: { alt: false, shift: true, ctrl: true, key: "D" }, triggerMode: "tap" };
  const conflicts = findBindingConflicts(bindings);
  assert.deepEqual(conflicts, [{ signature: "ctrl+shift+d", actionIds: ["voice", "enter"] }]);
});
