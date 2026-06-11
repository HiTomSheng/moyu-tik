# TT Studio

一个本地运行的双人实时互动网页，包含视频播放、评论式聊天、图片与 Emoji 消息，以及实时五子棋。

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

浏览器访问：

```text
http://localhost:5173
```

## 本地配置

在 `.env` 中设置登录账号、密码和素材的绝对路径：

```dotenv
MOYU_ACCOUNT=your-account
MOYU_PASSWORD=your-password
MOYU_SECRET=your-long-random-secret

MOYU_VIDEO_PATH=/absolute/path/to/video.mp4
MOYU_LOGO_PATH=/absolute/path/to/logo.svg
MOYU_KUROMI_AVATAR_PATH=/absolute/path/to/kuromi.jpeg
MOYU_BAKU_AVATAR_PATH=/absolute/path/to/baku.jpeg
```

`.env`、聊天数据库、上传图片和构建产物均被 Git 忽略。

## 常用命令

```bash
npm run build
npx tsc --noEmit
npm run smoke
npm audit
```

## 数据存储

- 聊天记录与棋局：`data/app.sqlite`
- 聊天上传图片：`uploads/`
- Emoji 素材：`vendor/tiktok-emojis/materials/`

Emoji 素材来自 [boqingren/tiktok-emojis](https://github.com/boqingren/tiktok-emojis)，其项目声明为 MIT License。
