import { crc32 } from 'node:zlib'

// Stored ZIP members for synthetic OOXML fixtures. The production ZIP reader never uses this.
export function encodeFixtureZip(entries: Record<string, string | Uint8Array>): Buffer {
  const members: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path)
    const data = Buffer.from(content)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    members.push(local, name, data)
    directory.push(central, name)
    offset += local.length + name.length + data.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(directory.length / 2, 8)
  end.writeUInt16LE(directory.length / 2, 10)
  end.writeUInt32LE(directory.reduce((length, part) => length + part.length, 0), 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...members, ...directory, end])
}
