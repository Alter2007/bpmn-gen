'use strict';
/**
 * 零依赖 ZIP 打包（仅 store 模式，不压缩）。
 *
 * 为什么自己写：项目原则是不引第三方运行期依赖；而界面版也要能"下载交付包"，
 * 必须把多个文件打成一个 zip。交付包只有十几 KB，不压缩完全够用。
 *
 * 支持 UTF-8 文件名（general purpose bit 11），中文文件名在 Windows 资源管理器里正常显示。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date: date & 0xffff, time: time & 0xffff };
}

/**
 * @param {Array<{name:string, content:string|Buffer}>} files
 * @param {Date} [when]
 * @returns {Buffer} zip 字节
 */
function zip(files, when) {
  const now = when || new Date();
  const dt = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 名称
    local.writeUInt16LE(0, 8);            // method: store
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, nameBuf, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);  // 中央目录签名
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dt.time, 12);
    central.writeUInt16LE(dt.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    locals.push(localFull);
    offset += localFull.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat(locals.concat([centralBuf, end]));
}

/**
 * 最小解包（只为测试自证）：读取中央目录，返回 {name, content}
 */
function unzip(buf) {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdPos < 0) throw new Error('不是 zip：找不到中央目录结尾');
  const count = buf.readUInt16LE(eocdPos + 10);
  let ptr = buf.readUInt32LE(eocdPos + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('中央目录签名错误');
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const size = buf.readUInt32LE(ptr + 24);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地头签名错误');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    out.push({ name: name, content: buf.slice(start, start + size) });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { zip, unzip, crc32 };
