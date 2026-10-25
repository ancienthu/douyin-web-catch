# 参考与许可说明

本项目参考了 [hankin-han/fetch_dy_user_profile](https://github.com/hankin-han/fetch_dy_user_profile) 的作者 ID 提取、作品分页接口线索及多个视频候选地址的处理思路。

参考提交：`3a6f9328ca545bb979f9e4817b42b25025eb0bde`。

本项目独立实现 Chrome 扩展、列表界面、状态管理、下载服务和 XLSX 导出；未打包参考项目的控制台脚本、评论模块、远程库或图片。为保留参考来源及其许可声明，附上该项目的 MIT 许可文本：

```text
MIT License

Copyright (c) 2026 Hankin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```


## 抖音下载候选地址策略参考

参考 [jiji262/douyin-downloader](https://github.com/jiji262/douyin-downloader)，提交 `9874f413b2c1f8ad6e731b26e3e05f402fc964f8`，重点为 `core/downloader_base.py` 的 `_build_video_url_candidates`、`_partition_video_candidates` 及画质选择方法。借鉴 CDN 直链优先、保留多个镜像和候选地址失败降级的思路；本扩展独立实现 JavaScript 逻辑，没有引入该项目的 Python 运行时或签名算法。原项目许可证如下：

```text
MIT License

Copyright (c) 2026 jiji262

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## TikTok 字段核对

TikTok 适配主要依据浏览器中当前作者主页正常返回的公开作品响应独立实现；另查阅了 [yt-dlp 的 TikTok 提取器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py) 核对初始页面数据入口和字段命名。未引入其运行时、Cookie 处理或签名实现。
