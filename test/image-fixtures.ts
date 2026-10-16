import { deflateSync } from "node:zlib";
import type { ImageAttachment } from "../src/model.js";

/** Real PNGs with CRCs, independent of host image tools or paid providers. */
export function png(width = 1, height = 1): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
export const image: ImageAttachment = { type: "image", name: "sample.png", mimeType: "image/png", data: png().toString("base64") };
