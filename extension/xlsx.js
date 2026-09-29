/* Minimal OOXML writer: UTF-8 XML + uncompressed ZIP. Text uses inlineStr, never formulas. */
(() => {
  'use strict';
  const encoder = new TextEncoder();
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function xml(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function column(n) { let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
  function zip(files) {
    const chunks = [], central = [];
    let offset = 0, centralSize = 0;
    for (const [name, value] of Object.entries(files)) {
      const path = encoder.encode(name), data = encoder.encode(value), crc = crc32(data);
      const header = new Uint8Array(30 + path.length), view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
      view.setUint16(12, 0x21, true); view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, path.length, true); header.set(path, 30);
      const entry = new Uint8Array(46 + path.length), ev = new DataView(entry.buffer);
      ev.setUint32(0, 0x02014b50, true); ev.setUint16(4, 20, true); ev.setUint16(6, 20, true); ev.setUint16(8, 0x800, true); ev.setUint16(14, 0x21, true);
      ev.setUint32(16, crc, true); ev.setUint32(20, data.length, true); ev.setUint32(24, data.length, true); ev.setUint16(28, path.length, true); ev.setUint32(42, offset, true); entry.set(path, 46);
      chunks.push(header, data); central.push(entry); offset += header.length + data.length; centralSize += entry.length;
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer), size = Object.keys(files).length;
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, size, true); ev.setUint16(10, size, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function sheet(rows) {
    const last = column(Math.max(...rows.map(r => r.length)) - 1) + rows.length;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="2" width="60" customWidth="1"/><col min="3" max="13" width="22" customWidth="1"/></cols><sheetData>${rows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => {
      const ref = column(ci) + (ri + 1), style = ri === 0 ? 1 : 0;
      return typeof v === 'number' && Number.isFinite(v) ? `<c r="${ref}" s="${style}"><v>${v}</v></c>` : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v ?? '').slice(0, 32767))}</t></is></c>`;
    }).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
  }
  function workbook(rows, metadata) {
    if (!rows.length || rows.length > 1048576) throw new Error('导出行数超出 Excel 支持范围。');
    const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
    return zip({
      '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="视频列表" sheetId="1" r:id="rId1"/><sheet name="采集说明" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
      'xl/styles.xml': `<?xml version="1.0"?><styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
      'xl/worksheets/sheet1.xml': sheet(rows),
      'xl/worksheets/sheet2.xml': sheet([['项目', '内容'], ...metadata])
    });
  }
  globalThis.DYXlsx = { workbook };
})();
