import { deflateRawSync } from "node:zlib";

/**
 * Internal zip writer for writeBundle (not exported from the package).
 * Deflate entries, a CRC32 table, zip32 only: it refuses rather than write
 * zip64. Every entry gets the fixed DOS date 1980-01-01 00:00, so the same
 * input gives the same bytes.
 */

/** Largest entry count a zip32 end-of-central-directory record holds. */
export const MAX_ENTRIES = 0xffff;
/** Largest size or offset a zip32 header field holds. */
export const MAX_ZIP32 = 0xffffffff;

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Throws when `value` does not fit a zip32 size or offset field. */
export function assertZip32(value: number, what: string): void {
  if (value > MAX_ZIP32) {
    throw new Error(`zip: ${what} ${value} exceeds the zip32 limit of 4 GiB (${MAX_ZIP32}); zip64 is not written`);
  }
}

export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`zip: ${entries.length} entries exceeds the zip32 limit of ${MAX_ENTRIES}; zip64 is not written`);
  }
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    assertZip32(data.length, `entry ${name} size`);
    assertZip32(compressed.length, `entry ${name} compressed size`);
    assertZip32(offset, `entry ${name} offset`);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: name is UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk start, internal and external attributes stay 0.
    header.writeUInt32LE(offset, 42);

    parts.push(local, nameBytes, compressed);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  assertZip32(offset, "central directory offset");
  assertZip32(centralSize, "central directory size");

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
