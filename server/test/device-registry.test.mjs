import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceRegistry } from "../device-registry.mjs";

test("device registry fails closed when required state is missing or invalid", () => {
  const directory = mkdtempSync(join(tmpdir(), "touchdeck-registry-test-"));
  const file = join(directory, "state.json");
  try {
    assert.throws(() => new DeviceRegistry(file, { required: true }), /required but missing/);

    writeFileSync(file, "{not-json", "utf8");
    assert.throws(() => new DeviceRegistry(file), SyntaxError);

    writeFileSync(file, JSON.stringify({ schemaVersion: 99, rooms: {} }), "utf8");
    assert.throws(() => new DeviceRegistry(file), /unsupported or invalid/);

    writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms: { "123456": {
      hostKeyHash: "not-a-hash", devices: [], pairKeyHash: null, pairExpires: 0, updatedAt: 1,
    } } }), "utf8");
    assert.throws(() => new DeviceRegistry(file), /invalid device registry room/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
