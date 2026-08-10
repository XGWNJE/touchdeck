import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^\d{6}$/;
const MAX_STORED_ROOMS = 10000;
const MAX_STORED_DEVICES = 32;

export const DEFAULT_DEVICE_STORE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "device-registry.json",
);

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, rooms: {} };
}

function validateState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !value.rooms || Array.isArray(value.rooms)) {
    throw new Error("unsupported or invalid device registry schema");
  }
  if (Object.keys(value.rooms).length > MAX_STORED_ROOMS) throw new Error("device registry room limit exceeded");
  for (const [code, room] of Object.entries(value.rooms)) {
    if (!CODE_RE.test(code) || !room || !HASH_RE.test(room.hostKeyHash)) {
      throw new Error("invalid device registry room record");
    }
    if (!Array.isArray(room.devices) || room.devices.length > MAX_STORED_DEVICES || room.devices.some((item) => !HASH_RE.test(item))) {
      throw new Error("invalid device registry device record");
    }
    if (room.pairKeyHash !== null && !HASH_RE.test(room.pairKeyHash)) {
      throw new Error("invalid device registry pair record");
    }
    if (!Number.isFinite(room.pairExpires) || !Number.isFinite(room.updatedAt)) {
      throw new Error("invalid device registry timestamp");
    }
  }
  return value;
}

export class DeviceRegistry {
  constructor(filePath = DEFAULT_DEVICE_STORE_PATH, { required = false } = {}) {
    this.filePath = filePath;
    if (!fs.existsSync(filePath)) {
      if (required) throw new Error(`device registry is required but missing: ${filePath}`);
      this.state = emptyState();
      this.#persist(this.state);
      return;
    }
    this.state = validateState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  }

  has(code) {
    return Object.hasOwn(this.state.rooms, code);
  }

  get(code) {
    const room = this.state.rooms[code];
    if (!room) return null;
    return {
      hostKeyHash: room.hostKeyHash,
      devices: new Set(room.devices),
      pairKeyHash: room.pairKeyHash,
      pairExpires: room.pairExpires,
      updatedAt: room.updatedAt,
    };
  }

  create(code, hostKeyHash, pairKeyHash, pairExpires) {
    if (this.has(code)) throw new Error("device registry room already exists");
    return this.#mutate((next) => {
      next.rooms[code] = {
        hostKeyHash,
        devices: [],
        pairKeyHash,
        pairExpires,
        updatedAt: Date.now(),
      };
    });
  }

  setPair(code, pairKeyHash, pairExpires) {
    return this.#mutateRoom(code, (room) => {
      room.pairKeyHash = pairKeyHash;
      room.pairExpires = pairExpires;
    });
  }

  registerDevice(code, deviceKeyHash) {
    return this.#mutateRoom(code, (room) => {
      if (!room.devices.includes(deviceKeyHash)) room.devices.push(deviceKeyHash);
      room.pairKeyHash = null;
      room.pairExpires = 0;
    });
  }

  revokeAll(code) {
    return this.#mutateRoom(code, (room) => {
      room.devices = [];
      room.pairKeyHash = null;
      room.pairExpires = 0;
    });
  }

  delete(code) {
    if (!this.has(code)) return;
    return this.#mutate((next) => { delete next.rooms[code]; });
  }

  #mutateRoom(code, fn) {
    if (!this.has(code)) throw new Error("device registry room missing");
    return this.#mutate((next) => {
      fn(next.rooms[code]);
      next.rooms[code].updatedAt = Date.now();
    });
  }

  #mutate(fn) {
    const next = structuredClone(this.state);
    fn(next);
    validateState(next);
    this.#persist(next);
    this.state = next;
  }

  #persist(state) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      // Windows does not allow fsync on a directory handle; production Linux does.
      if (process.platform !== "win32") {
        const dirFd = fs.openSync(directory, "r");
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* temp may not exist */ }
      throw error;
    }
  }
}
