const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = [...manifest.content_scripts.flatMap(c => c.js), manifest.background.service_worker, manifest.action.default_popup, 'popup.js', 'popup.css'];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (file.endsWith('.js')) new vm.Script(source, { filename: file });
}
for (const file of new Set([...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {})])) {
  const data = fs.readFileSync(path.join(root, file));
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG icon: ${file}`);
}
if (manifest.manifest_version !== 3 || manifest.permissions.some(p => !['downloads', 'storage'].includes(p))) throw new Error('Unexpected permissions');
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://*.douyinvod.com/*', 'https://*.douyincdn.com/*', 'https://*.tiktok.com/*', 'https://*.tiktokcdn.com/*', 'https://*.tiktokcdn-us.com/*'])) throw new Error('Unexpected CDN permissions');
console.log(`Manifest V3 and ${files.length} packaged files verified; permissions: ${manifest.permissions.join(', ')}`);
