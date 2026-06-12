import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { Server as SocketIOServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const uploadsDir = path.join(rootDir, 'uploads');
const distDir = path.join(rootDir, 'dist');
const emojiDir = path.join(rootDir, 'vendor', 'tiktok-emojis', 'materials');

const assetRoot = process.env.MOYU_ASSET_ROOT || path.join(rootDir, 'assets');
const videoPath =
  process.env.MOYU_VIDEO_PATH ||
  'https://nos.netease.com/youdata-netease/public-utilUpload-kzPXzn37ti6KLAMfGZ1DWR.mp4';
const avatarDir = process.env.MOYU_AVATAR_DIR || path.join(assetRoot, 'avatars');
const logoPath = process.env.MOYU_LOGO_PATH || path.join(assetRoot, 'logo.svg');
const avatarPaths = {
  kuromi:
    process.env.MOYU_KUROMI_AVATAR_PATH ||
    'https://img.cdn1.vip/i/6a2ba3c9da723_1781244873.jpg',
  baku:
    process.env.MOYU_BAKU_AVATAR_PATH ||
    'https://img.cdn1.vip/i/6a2ba3c9c5352_1781244873.jpg'
};

// 判断配置值是远程 URL 还是本地路径
const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

for (const dir of [dataDir, uploadsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'app.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    profile_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    avatar TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    image_url TEXT,
    emoji_code TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS game_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

const AUTH_ACCOUNT = envFirst('MOYU_ACCOUNT', 'MOYU_USERNAME', 'ACCOUNT', 'APP_ACCOUNT');
const AUTH_PASSWORD = envFirst('MOYU_PASSWORD', 'PASSWORD', 'APP_PASSWORD');
const AUTH_COOKIE = 'moyu_auth';
const JWT_SECRET = process.env.MOYU_SECRET || 'moyu-local-secret';
const PORT = Number(process.env.APPLICATION_PORT || process.env.PORT || 8080);

const allowedProfiles = [
  { id: 'kuromi', label: '库洛米', avatar: '/media/avatar/kuromi' },
  { id: 'baku', label: '巴库', avatar: '/media/avatar/baku' }
];

function nowIso() {
  return new Date().toISOString();
}

function emptyBoard() {
  return Array.from({ length: 15 }, () => Array(15).fill(null));
}

function defaultGameState() {
  return {
    board: emptyBoard(),
    turn: 'black',
    winner: null,
    lastMove: null,
    moves: [],
    updatedAt: nowIso()
  };
}

function loadGameState() {
  const row = db.prepare('SELECT payload FROM game_state WHERE id = 1').get();
  if (!row) {
    const initial = defaultGameState();
    db.prepare('INSERT INTO game_state (id, payload, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(initial), nowIso());
    return initial;
  }
  try {
    const parsed = JSON.parse(row.payload);
    return { ...defaultGameState(), ...parsed };
  } catch {
    const initial = defaultGameState();
    db.prepare('UPDATE game_state SET payload = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(initial), nowIso());
    return initial;
  }
}

let currentGameState = loadGameState();

function saveGameState(state) {
  currentGameState = {
    ...state,
    updatedAt: nowIso()
  };
  db.prepare(`
    INSERT INTO game_state (id, payload, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(JSON.stringify(currentGameState), currentGameState.updatedAt);
}

function getEmojiOptions() {
  return fs
    .readdirSync(emojiDir)
    .filter((name) => name.toLowerCase().endsWith('.svg'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      code: path.basename(name, '.svg'),
      url: `/emoji-assets/${encodeURIComponent(name)}`
    }));
}

function upsertProfile(profileId, nickname) {
  const profile = allowedProfiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error('invalid profile');
  }
  const safeNickname = String(nickname || profile.label).trim().slice(0, 24) || profile.label;
  db.prepare(`
    INSERT INTO profiles (profile_id, nickname, avatar, updated_at)
    VALUES (@profileId, @nickname, @avatar, @updatedAt)
    ON CONFLICT(profile_id) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar, updated_at = excluded.updated_at
  `).run({
    profileId,
    nickname: safeNickname,
    avatar: profile.avatar,
    updatedAt: nowIso()
  });
  return { profileId, nickname: safeNickname, avatar: profile.avatar };
}

function getProfile(profileId) {
  return db.prepare('SELECT profile_id AS profileId, nickname, avatar, updated_at AS updatedAt FROM profiles WHERE profile_id = ?').get(profileId) || null;
}

function listMessages(limit = 200) {
  return db
    .prepare(
      `
      SELECT
        id,
        profile_id AS profileId,
        nickname,
        avatar,
        kind,
        text,
        image_url AS imageUrl,
        emoji_code AS emojiCode,
        created_at AS createdAt
      FROM messages
      ORDER BY created_at ASC
      LIMIT ?
    `
    )
    .all(limit);
}

function insertMessage(message) {
  db.prepare(`
    INSERT INTO messages (
      id, profile_id, nickname, avatar, kind, text, image_url, emoji_code, created_at
    ) VALUES (
      @id, @profileId, @nickname, @avatar, @kind, @text, @imageUrl, @emojiCode, @createdAt
    )
  `).run(message);
}

function issueAuthToken() {
  return jwt.sign({ scope: 'moyu-local' }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyAuthToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const chunk of header.split(';')) {
    const [rawKey, ...rest] = chunk.trim().split('=');
    if (rawKey === name) {
      return rest.join('=');
    }
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = req.cookies[AUTH_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

function buildConfig() {
  return {
    appName: 'TT Studio',
    logoUrl: '/media/logo',
    videoUrl: '/media/video/main',
    avatarOptions: allowedProfiles.map((profile) => ({
      ...profile
    })),
    emojiOptions: getEmojiOptions()
  };
}

function checkWin(board, row, col, color) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  for (const [dx, dy] of directions) {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dx * sign;
      let c = col + dy * sign;
      while (board[r] && board[r][c] === color) {
        count += 1;
        r += dx * sign;
        c += dy * sign;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

function getPlayerColor(profileId) {
  if (profileId === 'kuromi') return 'black';
  if (profileId === 'baku') return 'white';
  return null;
}

function cloneState(state) {
  return {
    ...state,
    board: state.board.map((row) => [...row]),
    moves: state.moves.map((move) => ({ ...move }))
  };
}

function resetGameState() {
  const state = defaultGameState();
  saveGameState(state);
  return state;
}

function findLastMoveColor(state) {
  if (!state.moves.length) return null;
  return state.moves[state.moves.length - 1]?.color || null;
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.use(cookieParser());
app.use(express.json({ limit: '12mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use('/emoji-assets', express.static(emojiDir));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      cb(null, `${Date.now()}-${nanoid(10)}${ext}`);
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.get('/api/config', (_req, res) => {
  res.json(buildConfig());
});

app.get('/api/session', (req, res) => {
  const token = req.cookies[AUTH_COOKIE];
  if (!token) {
    res.json({ authenticated: false });
    return;
  }
  try {
    verifyAuthToken(token);
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

app.post('/api/login', (req, res) => {
  if (!AUTH_ACCOUNT || !AUTH_PASSWORD) {
    res.status(500).json({
      error: '登录配置缺失：请设置 MOYU_ACCOUNT 和 MOYU_PASSWORD'
    });
    return;
  }
  const { account, password } = req.body || {};
  if (account !== AUTH_ACCOUNT || password !== AUTH_PASSWORD) {
    res.status(401).json({ error: '账号或密码错误' });
    return;
  }
  res.cookie(AUTH_COOKIE, issueAuthToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.json({ ok: true });
});

app.get('/api/bootstrap', requireAuth, (req, res) => {
  const profileId = String(req.query.profileId || '');
  const profile = profileId ? getProfile(profileId) : null;
  res.json({
    ...buildConfig(),
    profile,
    messages: listMessages(200),
    gameState: currentGameState,
    currentTime: nowIso()
  });
});

app.get('/api/messages', requireAuth, (_req, res) => {
  res.json({ messages: listMessages(200) });
});

app.get('/api/game-state', requireAuth, (_req, res) => {
  res.json({ gameState: currentGameState });
});

app.post('/api/profile', requireAuth, (req, res) => {
  const { profileId, nickname } = req.body || {};
  try {
    const profile = upsertProfile(profileId, nickname);
    res.json({ profile });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid profile' });
  }
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'missing file' });
    return;
  }
  res.json({
    url: `/uploads/${encodeURIComponent(req.file.filename)}`,
    mimeType: req.file.mimetype,
    originalName: req.file.originalname
  });
});

app.get('/media/logo', (_req, res) => {
  if (isHttpUrl(logoPath)) return res.redirect(302, logoPath);
  res.sendFile(logoPath);
});

app.get('/media/avatar/:profileId', (req, res) => {
  const target = avatarPaths[req.params.profileId];
  if (!target) {
    res.status(404).end();
    return;
  }
  if (isHttpUrl(target)) return res.redirect(302, target);
  res.sendFile(target);
});

app.get('/media/video/main', (_req, res) => {
  if (isHttpUrl(videoPath)) return res.redirect(302, videoPath);
  res.sendFile(videoPath);
});

const presenceCounts = new Map();
let pendingUndo = null;

function bumpPresence(profileId, delta) {
  const next = Math.max(0, (presenceCounts.get(profileId) || 0) + delta);
  if (next === 0) presenceCounts.delete(profileId);
  else presenceCounts.set(profileId, next);
}

function presenceSnapshot() {
  return {
    kuromi: presenceCounts.has('kuromi'),
    baku: presenceCounts.has('baku')
  };
}

function emitPresence() {
  io.emit('presence:update', presenceSnapshot());
}

function socketProfileLabel(profileId) {
  return allowedProfiles.find((item) => item.id === profileId)?.label || profileId;
}

io.use((socket, next) => {
  const token = readCookie(socket.request.headers.cookie || '', AUTH_COOKIE);
  if (!token) {
    next(new Error('unauthorized'));
    return;
  }
  try {
    socket.data.auth = verifyAuthToken(token);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.emit('app:config', buildConfig());
  socket.emit('game:state', currentGameState);
  socket.emit('presence:update', presenceSnapshot());

  socket.on('profile:join', (payload = {}, ack) => {
    try {
      const { profileId, nickname } = payload;
      const profile = upsertProfile(profileId, nickname);
      if (socket.data.profileId) {
        bumpPresence(socket.data.profileId, -1);
      }
      socket.data.profileId = profile.profileId;
      socket.data.nickname = profile.nickname;
      socket.data.avatar = profile.avatar;
      bumpPresence(profile.profileId, 1);
      socket.join('main-room');
      emitPresence();
      socket.emit('profile:joined', {
        profile,
        presence: presenceSnapshot()
      });
      ack?.({ ok: true, profile, presence: presenceSnapshot() });
    } catch (error) {
      ack?.({ ok: false, error: error instanceof Error ? error.message : 'invalid profile' });
    }
  });

  socket.on('typing', (payload = {}) => {
    socket.to('main-room').emit('typing', {
      profileId: socket.data.profileId || null,
      nickname: socket.data.nickname || '',
      isTyping: Boolean(payload.isTyping)
    });
  });

  socket.on('chat:send', (payload = {}, ack) => {
    const profileId = socket.data.profileId;
    if (!profileId) {
      ack?.({ ok: false, error: 'profile not joined' });
      return;
    }
    const profile = getProfile(profileId) || upsertProfile(profileId, socket.data.nickname);
    const message = {
      id: nanoid(),
      profileId,
      nickname: profile.nickname,
      avatar: profile.avatar,
      kind: payload.kind === 'image' ? 'image' : payload.kind === 'emoji' ? 'emoji' : 'text',
      text: typeof payload.text === 'string' ? payload.text.slice(0, 4000) : '',
      imageUrl: typeof payload.imageUrl === 'string' ? payload.imageUrl : '',
      emojiCode: typeof payload.emojiCode === 'string' ? payload.emojiCode : '',
      createdAt: nowIso()
    };
    insertMessage(message);
    io.emit('chat:new', message);
    ack?.({ ok: true, message });
  });

  socket.on('game:move', (payload = {}, ack) => {
    const profileId = socket.data.profileId;
    const color = getPlayerColor(profileId);
    if (!color) {
      ack?.({ ok: false, error: 'invalid player' });
      return;
    }
    if (currentGameState.winner) {
      ack?.({ ok: false, error: 'game finished' });
      return;
    }
    if (currentGameState.turn !== color) {
      ack?.({ ok: false, error: 'not your turn' });
      return;
    }

    const row = Number(payload.row);
    const col = Number(payload.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= 15 || col >= 15) {
      ack?.({ ok: false, error: 'invalid move' });
      return;
    }
    if (currentGameState.board[row][col]) {
      ack?.({ ok: false, error: 'occupied' });
      return;
    }

    const next = cloneState(currentGameState);
    next.board[row][col] = color;
    next.moves.push({
      row,
      col,
      color,
      profileId,
      nickname: socket.data.nickname || socketProfileLabel(profileId),
      createdAt: nowIso()
    });
    next.lastMove = { row, col, color, profileId };
    next.turn = color === 'black' ? 'white' : 'black';
    if (checkWin(next.board, row, col, color)) {
      next.winner = color;
    }
    pendingUndo = null;
    saveGameState(next);
    io.emit('game:state', currentGameState);
    ack?.({ ok: true, gameState: currentGameState });
  });

  socket.on('game:reset', (_payload = {}, ack) => {
    pendingUndo = null;
    const next = resetGameState();
    io.emit('game:state', next);
    ack?.({ ok: true, gameState: next });
  });

  socket.on('game:undo:request', (payload = {}, ack) => {
    const profileId = socket.data.profileId;
    if (!profileId || !currentGameState.moves.length) {
      ack?.({ ok: false, error: 'nothing to undo' });
      return;
    }
    const target = payload.targetProfileId || (profileId === 'kuromi' ? 'baku' : 'kuromi');
    pendingUndo = {
      fromProfileId: profileId,
      targetProfileId: target,
      createdAt: nowIso()
    };
    socket.to('main-room').emit('game:undo-request', {
      fromProfileId: profileId,
      fromNickname: socket.data.nickname || '',
      targetProfileId: target
    });
    ack?.({ ok: true });
  });

  socket.on('game:undo:respond', (payload = {}, ack) => {
    const profileId = socket.data.profileId;
    const accepted = Boolean(payload.accepted);
    if (!pendingUndo || pendingUndo.targetProfileId !== profileId) {
      ack?.({ ok: false, error: 'no pending request' });
      return;
    }
    if (!accepted) {
      socket.to('main-room').emit('game:undo-rejected', {
        byProfileId: profileId,
        byNickname: socket.data.nickname || ''
      });
      pendingUndo = null;
      ack?.({ ok: true, accepted: false });
      return;
    }
    const next = cloneState(currentGameState);
    const undone = next.moves.pop();
    if (!undone) {
      pendingUndo = null;
      ack?.({ ok: false, error: 'nothing to undo' });
      return;
    }
    next.board[undone.row][undone.col] = null;
    const previous = next.moves[next.moves.length - 1];
    next.lastMove = previous
      ? {
          row: previous.row,
          col: previous.col,
          color: previous.color,
          profileId: previous.profileId
        }
      : null;
    next.turn = undone.color;
    next.winner = null;
    pendingUndo = null;
    saveGameState(next);
    io.emit('game:state', currentGameState);
    ack?.({ ok: true, accepted: true, gameState: currentGameState });
  });

  socket.on('disconnect', () => {
    if (socket.data.profileId) {
      bumpPresence(socket.data.profileId, -1);
      emitPresence();
    }
  });
});

if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.use((_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(200).send('Moyu server is running. Start the Vite client on port 5173.');
  });
}

server.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});
