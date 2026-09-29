const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/core.js');
require('../extension/xlsx.js');
const C = globalThis.DYCore;
const author = 'MS4wLjAB_test';
const fixture = overrides => ({
  aweme_id: '7690524354895421946', desc: '中文标题 <测试>\n完整简介 & 换行',
  author: { sec_uid: author, nickname: '测试作者' }, create_time: 1750000000,
  statistics: { digg_count: 0, share_count: 12, comment_count: 34, play_count: 0 },
  video: { play_addr: { url_list: ['https://v3.douyinvod.com/video.mp4', 'https://v3.douyinvod.com/video.mp4'] } }, ...overrides
});
test('author parsing only accepts actual HTTPS Douyin user pages', () => {
  assert.equal(C.authorFromURL(`https://www.douyin.com/user/${author}?from=search`), author);
  for (const url of ['https://www.douyin.com.evil.test/user/id', 'http://www.douyin.com/user/id', 'https://www.douyin.com/video/123', 'invalid']) assert.equal(C.authorFromURL(url), '');
});
test('preserves long IDs, literal description and zero likes without storing plays', () => {
  const r = C.normalize(fixture(), author);
  assert.equal(r.id, '7690524354895421946'); assert.equal(r.likes, 0); assert.equal('play' in r, false);
  assert.equal(r.title, '中文标题 <测试>'); assert.equal(r.description, '中文标题 <测试>\n完整简介 & 换行');
  assert.equal(r.candidates.length, 1); assert.equal('playStatus' in r, false);
});
test('rejects wrong authors, image posts, corrupt IDs and unsafe rounded numeric IDs', () => {
  assert.equal(C.normalize(fixture({ author: { sec_uid: 'another' } }), author), null);
  assert.equal(C.normalize(fixture({ aweme_id: Number('7690524354895421946') }), author), null);
  assert.equal(C.normalize(fixture({ aweme_id: '<script>' }), author), null);
  assert.equal(C.normalize(fixture({ images: [{ url_list: ['image'] }] }), author).image, true);
});
test('metrics distinguish missing / malformed from actual zero', () => {
  for (const value of [undefined, null, '', false, NaN, -1, Infinity, '1.5', '未知']) assert.equal(C.count(value), null);
  assert.equal(C.count('0'), 0); assert.equal(C.count('123'), 123);
});
test('video candidates reject spoofed domains, HTTP, credentials and executable URLs', () => {
  for (const url of ['https://douyin.com.evil.test/a', 'https://evildouyin.com/a', 'http://v3.douyinvod.com/a', 'https://x:y@v3.douyinvod.com/a', 'https://v3.douyinvod.com:3000/a', 'javascript:alert(1)', 'file:///tmp/a']) assert.equal(C.mediaURL(url), '');
  assert.equal(C.mediaURL('https://v3.douyinvod.com/a'), 'https://v3.douyinvod.com/a');
});
test('only an explicit final-page marker completes pagination', () => {
  const data = { status_code: 0, aweme_list: [], has_more: false };
  assert.equal(C.pageDecision(data, '0', new Set(['0']), 1).complete, true);
  assert.throws(() => C.validatePage({ status_code: 0, aweme_list: [] }), /分页状态/);
  assert.throws(() => C.validatePage({ status_code: 1, aweme_list: [], has_more: 0 }));
});
test('pagination rejects stuck / cyclic / missing cursors and consecutive empty pages', () => {
  const data = { status_code: 0, aweme_list: [], has_more: 1, max_cursor: 10 };
  assert.throws(() => C.pageDecision(data, '10', new Set(['0']), 1), /重复/);
  assert.throws(() => C.pageDecision(data, '20', new Set(['10']), 1), /重复/);
  assert.throws(() => C.pageDecision({ ...data, max_cursor: undefined }, '0', new Set(), 1), /无效/);
  assert.throws(() => C.pageDecision(data, '0', new Set(), 3), /连续三页/);
  assert.deepEqual(C.pageDecision(data, '0', new Set(), 1), { complete: false, next: '10' });
});
test('sorting keeps unknown values last and search includes full description', () => {
  const rows = [{ id: '1', title: 'a', description: 'keyword', likes: null }, { id: '2', title: 'b', description: '', likes: 0 }, { id: '3', title: 'c', description: '', likes: 20 }];
  assert.deepEqual(C.selectRows(rows, '', 'likes:desc').map(r => r.id), ['3', '2', '1']);
  assert.deepEqual(C.selectRows(rows, '', 'likes:asc').map(r => r.id), ['2', '3', '1']);
  assert.equal(C.selectRows(rows, 'KEYWORD', 'likes:desc').length, 1);
});
test('Excel rows keep identifiers as text and unknown counts as status', () => {
  const row = C.normalize(fixture({ statistics: { digg_count: 0 } }), author);
  const exported = C.exportRows([row]);
  assert.equal(exported[1][3], '未提供'); assert.equal(exported[1][2], 0);
  assert.equal(typeof exported[1][5], 'string'); assert.equal(exported[1][5], row.id);
  assert.equal(exported[0].some(h => h.includes('播放')), false);
});
test('filenames cannot escape download directory', () => {
  assert.equal(C.safeFilename('../../a/b\\c:*?'), '_.._a_b_c___');
  assert.equal(C.safeFilename('...'), '视频');
});
test('workbook is a real ZIP with XML text escaping and no formula nodes', async () => {
  const blob = DYXlsx.workbook([['名称', 'ID', '点赞'], ['=HYPERLINK("https://evil.test") & <中文>\n第二行', '7690524354895421946', 0]], [['状态', '部分结果']]);
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const text = bytes.toString('utf8');
  assert.match(text, /&amp; &lt;中文&gt;/); assert.match(text, /7690524354895421946/); assert.doesNotMatch(text, /<f[ >]/);
  assert.match(text, /t="inlineStr"/); assert.match(text, /<v>0<\/v>/);
});
test('write a workbook fixture for independent openpyxl validation', async () => {
  const fs = require('node:fs');
  const r = C.normalize(fixture(), author);
  r.description = '=SUM(1,2)\n中文 & <tag> 😀';
  const blob = DYXlsx.workbook(C.exportRows([r]), [['状态', '部分结果']]);
  fs.writeFileSync('/private/tmp/douyin-worklist-test.xlsx', Buffer.from(await blob.arrayBuffer()));
});
test('bounded cache refuses overflow without evicting searchable records', () => {
  const rows = new C.BoundedRows(2, 2000);
  rows.set('a', { title: '第一条' }); rows.set('b', { title: '第二条' });
  assert.throws(() => rows.set('c', { title: '第三条' }), { code: 'CAPACITY' });
  assert.equal(rows.size, 2); assert.equal(rows.get('a').title, '第一条');
  rows.set('a', { title: 'updated' }); assert.equal(rows.size, 2);
  rows.clear(); assert.equal(rows.size, 0); assert.equal(rows.bytes, 0);
});
test('bounded cache tracks replacement/deletion sizes and protects the old value on oversized update', () => {
  const value = { title: 'hello' }, size = JSON.stringify(value).length * 2;
  const rows = new C.BoundedRows(10, size + 4); rows.set('a', value);
  assert.equal(rows.bytes, size);
  assert.throws(() => rows.set('a', { title: 'x'.repeat(100) }), { code: 'CAPACITY' });
  assert.deepEqual(rows.get('a'), value); assert.equal(rows.bytes, size);
  rows.delete('a'); assert.equal(rows.bytes, 0);
});
test('candidate ordering uses CDN mirrors first, playback endpoints second, watermark fallback last', () => {
  const play = 'https://www.douyin.com/aweme/v1/play/?video_id=abc';
  const cdn = 'https://v11.douyinvod.com/file.mp4';
  const mirror = 'https://v26.douyinvod.com/file.mp4';
  const watermarked = 'https://v1.douyinvod.com/file.mp4?watermark=1';
  assert.deepEqual(C.preferCandidates([play, watermarked, cdn, mirror, cdn]), [cdn, mirror, play, watermarked]);
});
test('collects H264/H265 and bitrate mirrors, preferring higher-resolution direct files', () => {
  const video = {
    play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=abc'] },
    play_addr_h264: { url_list: ['https://v3.douyinvod.com/h264.mp4'] },
    play_addr_265: { url_list: ['https://v3.douyinvod.com/h265.mp4'] },
    bit_rate: [
      { bit_rate: 100, play_addr: { width: 640, height: 360, url_list: ['https://v3.douyinvod.com/low.mp4'] } },
      { bit_rate: 500, play_addr: { width: 1920, height: 1080, url_list: ['https://v3.douyinvod.com/high.mp4', 'https://v9.douyinvod.com/high.mp4'] } }
    ]
  };
  const list = C.videoCandidates(video);
  assert.equal(list[0], 'https://v3.douyinvod.com/high.mp4');
  assert.equal(list[1], 'https://v9.douyinvod.com/high.mp4');
  assert.ok(list.includes('https://v3.douyinvod.com/h264.mp4'));
  assert.ok(list.includes('https://v3.douyinvod.com/h265.mp4'));
  assert.match(list.at(-1), /www.douyin.com/);
});
