import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { io } from 'socket.io-client';

const base = 'http://localhost:3001';
const root = process.cwd();
const db = new Database(path.join(root, 'data', 'app.sqlite'));
const smokeAccount = process.env.MOYU_ACCOUNT;
const smokePassword = process.env.MOYU_PASSWORD;
const smokeImage = process.env.MOYU_BAKU_AVATAR_PATH;

async function login() {
  if (!smokeAccount || !smokePassword) {
    throw new Error('MOYU_ACCOUNT and MOYU_PASSWORD are required for smoke tests');
  }
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: smokeAccount, password: smokePassword })
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  return response.headers.get('set-cookie') || '';
}

async function postJson(url, cookie, body) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} failed: ${payload.error || response.status}`);
  return payload;
}

async function uploadImage(cookie, filePath, fileName = 'smoke.jpg') {
  const bytes = await fs.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), fileName);
  const response = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`upload failed: ${payload.error || response.status}`);
  return payload.url;
}

function connect(cookie) {
  return io(base, {
    transports: ['websocket'],
    extraHeaders: {
      Cookie: cookie
    }
  });
}

function ack(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response) => {
      if (!response?.ok) {
        reject(new Error(response?.error || `${event} failed`));
        return;
      }
      resolve(response);
    });
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  const cookie = await login();
  await postJson('/api/profile', cookie, { profileId: 'kuromi', nickname: '库洛米' });
  await postJson('/api/profile', cookie, { profileId: 'baku', nickname: '巴库' });

  const kuromi = connect(cookie);
  const baku = connect(cookie);

  const waitConnect = (socket) => new Promise((resolve) => socket.on('connect', resolve));
  await Promise.all([waitConnect(kuromi), waitConnect(baku)]);

  await Promise.all([
    ack(kuromi, 'profile:join', { profileId: 'kuromi', nickname: '库洛米' }),
    ack(baku, 'profile:join', { profileId: 'baku', nickname: '巴库' })
  ]);

  await ack(kuromi, 'game:reset');
  const messagePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('chat message timeout')), 5000);
    baku.on('chat:new', (message) => {
      if (message.text === '__smoke__ text') {
        clearTimeout(timeout);
        resolve(message);
      }
    });
  });
  await ack(kuromi, 'chat:send', { kind: 'text', text: '__smoke__ text' });
  const messageSeen = await messagePromise;

  const emojiCode = 'smile';
  await ack(kuromi, 'chat:send', { kind: 'emoji', emojiCode });
  if (!smokeImage) {
    throw new Error('MOYU_BAKU_AVATAR_PATH is required for smoke tests');
  }
  const imageUrl = await uploadImage(cookie, smokeImage, 'smoke.jpeg');
  await ack(kuromi, 'chat:send', { kind: 'image', imageUrl, text: '__smoke__ image' });

  await ack(kuromi, 'game:move', { row: 7, col: 7 });
  await ack(baku, 'game:move', { row: 7, col: 8 });
  const finalMove = await ack(kuromi, 'game:move', { row: 7, col: 9 });
  const state = finalMove.gameState;

  const after = db.prepare(`
    SELECT count(*) AS count FROM messages
    WHERE created_at >= ? AND (
      text = '__smoke__ text'
      OR text = '__smoke__ image'
      OR emoji_code = ?
    )
  `).get(startedAt, emojiCode);
  if (after.count < 3) {
    throw new Error('expected smoke messages were not persisted');
  }

  db.prepare(`
    DELETE FROM messages
    WHERE created_at >= ? AND (
      text = '__smoke__ text'
      OR text = '__smoke__ image'
      OR emoji_code = ?
    )
  `).run(startedAt, emojiCode);
  await fs.unlink(path.join(root, imageUrl.replace(/^\//, ''))).catch(() => undefined);

  await ack(kuromi, 'game:reset');
  kuromi.disconnect();
  baku.disconnect();

  const finalCount = db.prepare(`
    SELECT count(*) AS count FROM messages
    WHERE created_at >= ? AND (
      text LIKE '__smoke__%'
      OR emoji_code = ?
    )
  `).get(startedAt, emojiCode);
  if (finalCount.count !== 0) {
    throw new Error('cleanup failed');
  }

  console.log(JSON.stringify({
    ok: true,
    messageSeen: Boolean(messageSeen),
    moves: state.moves.length
  }));
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
