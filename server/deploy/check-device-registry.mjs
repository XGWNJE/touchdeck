import fs from "node:fs";

const file = process.env.TOUCHDECK_DEVICE_STORE || "/var/lib/touchdeck-signal/device-registry.json";
const state = JSON.parse(fs.readFileSync(file, "utf8"));
if (state.schemaVersion !== 1 || !state.rooms || Array.isArray(state.rooms)) {
  throw new Error("invalid device registry schema");
}
const rooms = Object.values(state.rooms);
const devices = rooms.reduce((sum, room) => sum + (Array.isArray(room.devices) ? room.devices.length : 0), 0);
const pendingPairs = rooms.filter((room) => typeof room.pairKeyHash === "string" && room.pairExpires > Date.now()).length;
console.log(`schema=${state.schemaVersion} rooms=${rooms.length} devices=${devices} pendingPairs=${pendingPairs}`);
