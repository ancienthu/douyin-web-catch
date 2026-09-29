import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'extension' / 'manifest.json').read_text())['version']
output = root / 'dist' / f'douyin-worklist-{version}.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for file in sorted((root / 'extension').rglob('*')):
        if file.is_file() and not file.name.startswith('.') and file.suffix != '.svg':
            archive.write(file, Path('douyin-worklist') / file.relative_to(root / 'extension'))
    readme = (root / 'README.md').read_text()
    readme = readme.replace('src="extension/icons/', 'src="icons/')
    readme = readme.replace(f'[下载本地安装包](dist/douyin-worklist-{version}.zip)，解压后保留 `douyin-worklist` 文件夹。', '解压后保留当前 `douyin-worklist` 文件夹，按以下步骤安装。')
    readme = readme.replace(f'[下载本地安装包](https://github.com/ancienthu/douyin-web-catch/raw/refs/heads/main/dist/douyin-worklist-{version}.zip)，解压后保留 `douyin-worklist` 文件夹。', '解压后保留当前 `douyin-worklist` 文件夹，按以下步骤安装。')
    if (root / 'LICENSE').exists():
        archive.write(root / 'LICENSE', 'douyin-worklist/LICENSE')
    readme = readme.split('## 开发')[0] + '参考项目及其许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。\n'
    archive.writestr('douyin-worklist/README.md', readme)
    archive.write(root / 'THIRD_PARTY_NOTICES.md', 'douyin-worklist/THIRD_PARTY_NOTICES.md')
print(output)
