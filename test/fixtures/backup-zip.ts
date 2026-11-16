// Deliberately permissive ZIP fixture writer for hostile-header tests. Never used by Ion.
export function zipFixture(entries: Array<{ name: string; data: Buffer; localName?: string; mode?: number; flags?: number; size?: number; badCrc?: boolean }>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name)
    let crc = 0xffffffff
    for (const byte of entry.data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
    crc = ((crc ^ 0xffffffff) + Number(Boolean(entry.badCrc))) >>> 0
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0x800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.size ?? entry.data.length, 22); local.writeUInt16LE(localName.length, 26)
    locals.push(local, localName, entry.data)
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x314, 4); header.writeUInt16LE(20, 6)
    header.writeUInt16LE(entry.flags ?? 0x800, 8); header.writeUInt32LE(crc, 16); header.writeUInt32LE(entry.data.length, 20); header.writeUInt32LE(entry.size ?? entry.data.length, 24)
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(((entry.mode ?? 0o100600) * 65536) >>> 0, 38); header.writeUInt32LE(offset, 42)
    central.push(header, name); offset += local.length + localName.length + entry.data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
