import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type ProfileId = 'kuromi' | 'baku';
type ChatKind = 'text' | 'image' | 'emoji';
type CellColor = 'black' | 'white';

type ProfileOption = {
  id: ProfileId;
  label: string;
  avatar: string;
};

type Config = {
  appName: string;
  logoUrl: string;
  videoUrl: string;
  avatarOptions: ProfileOption[];
  emojiOptions: Array<{ code: string; url: string }>;
};

type Profile = {
  profileId: ProfileId;
  nickname: string;
  avatar: string;
};

type Message = {
  id: string;
  profileId: ProfileId | string;
  nickname: string;
  avatar: string;
  kind: ChatKind;
  text: string;
  imageUrl: string;
  emojiCode: string;
  createdAt: string;
};

type GameMove = {
  row: number;
  col: number;
  color: CellColor;
  profileId: string;
  nickname: string;
  createdAt: string;
};

type GameState = {
  board: Array<Array<CellColor | null>>;
  turn: CellColor;
  winner: CellColor | null;
  lastMove: { row: number; col: number; color: CellColor; profileId: string } | null;
  moves: GameMove[];
  updatedAt?: string;
};

type Presence = {
  kuromi: boolean;
  baku: boolean;
};

type BootResponse = Config & {
  profile: Profile | null;
  messages: Message[];
  gameState: GameState;
};

type LoginState = {
  account: string;
  password: string;
};

const STORAGE_PROFILE_ID = 'moyu.profileId';
const STORAGE_PROFILE_NAME = 'moyu.profileName';

const defaultLogin: LoginState = {
  account: '',
  password: ''
};

const defaultPresence: Presence = {
  kuromi: false,
  baku: false
};

function defaultBoard() {
  return Array.from({ length: 15 }, () => Array<CellColor | null>(15).fill(null));
}

function defaultGameState(): GameState {
  return {
    board: defaultBoard(),
    turn: 'black',
    winner: null,
    lastMove: null,
    moves: []
  };
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || response.statusText);
  }
  return payload as T;
}

function formatTime(value: string) {
  const date = new Date(value);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function bubbleClass(kind: ChatKind) {
  if (kind === 'image') return 'message-bubble message-bubble-image';
  if (kind === 'emoji') return 'message-bubble message-bubble-emoji';
  return 'message-bubble';
}

function cellKey(row: number, col: number) {
  return `${row}-${col}`;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [phase, setPhase] = useState<'loading' | 'login' | 'profile' | 'app'>('loading');
  const [login, setLogin] = useState<LoginState>(defaultLogin);
  const [profileChoice, setProfileChoice] = useState<ProfileId>('kuromi');
  const [nickname, setNickname] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [gameState, setGameState] = useState<GameState>(defaultGameState());
  const [presence, setPresence] = useState<Presence>(defaultPresence);
  const [typingName, setTypingName] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<{ fromProfileId: string; fromNickname: string; targetProfileId: string } | null>(null);
  const [composer, setComposer] = useState('');
  const [panel, setPanel] = useState<'video' | 'game'>('video');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const currentProfileLabel = useMemo(() => {
    if (!profile) return '未登录';
    return profile.nickname;
  }, [profile]);

  function pushMessage(message: Message) {
    setMessages((prev) => [...prev, message].slice(-200));
  }

  async function loadBootstrap(profileId: ProfileId, nicknameOverride?: string) {
    const data = await readJson<BootResponse>(`/api/bootstrap?profileId=${encodeURIComponent(profileId)}`);
    const selected = data.profile || {
      profileId,
      nickname: nicknameOverride || data.avatarOptions.find((item) => item.id === profileId)?.label || profileId,
      avatar: data.avatarOptions.find((item) => item.id === profileId)?.avatar || ''
    };
    setConfig(data);
    setProfile(selected);
    setMessages(data.messages || []);
    setGameState(data.gameState || defaultGameState());
    setPresence(defaultPresence);
    setPhase('app');
    localStorage.setItem(STORAGE_PROFILE_ID, selected.profileId);
    localStorage.setItem(STORAGE_PROFILE_NAME, selected.nickname);
  }

  async function bootstrapAfterLogin() {
    const savedProfileId = localStorage.getItem(STORAGE_PROFILE_ID) as ProfileId | null;
    const savedNickname = localStorage.getItem(STORAGE_PROFILE_NAME) || '';
    if (savedProfileId === 'kuromi' || savedProfileId === 'baku') {
      await loadBootstrap(savedProfileId, savedNickname);
      return;
    }
    setPhase('profile');
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await readJson<Config>('/api/config');
        if (!alive) return;
        setConfig(cfg);
        const session = await readJson<{ authenticated: boolean }>('/api/session');
        if (!alive) return;
        if (!session.authenticated) {
          setPhase('login');
          return;
        }
        await bootstrapAfterLogin();
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : '初始化失败');
        setPhase('login');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.title = config?.appName || 'TT Studio';
  }, [config]);

  useEffect(() => {
    if (phase !== 'app' || !profile) return;
    const socket = io({
      path: '/socket.io',
      withCredentials: true
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('profile:join', { profileId: profile.profileId, nickname: profile.nickname });
    });
    socket.on('chat:new', (message: Message) => {
      pushMessage(message);
      if (message.profileId !== profile.profileId) {
        setTypingName(null);
      }
    });
    socket.on('game:state', (next: GameState) => {
      setGameState(next);
    });
    socket.on('presence:update', (next: Presence) => {
      setPresence(next);
    });
    socket.on('typing', (payload: { profileId: string; nickname: string; isTyping: boolean }) => {
      if (payload.profileId && payload.profileId !== profile.profileId) {
        setTypingName(payload.isTyping ? payload.nickname : null);
      }
    });
    socket.on('game:undo-request', (payload: { fromProfileId: string; fromNickname: string; targetProfileId: string }) => {
      if (payload.targetProfileId === profile.profileId) {
        setPendingUndo(payload);
      }
    });
    socket.on('game:undo-rejected', () => {
      setPendingUndo(null);
    });
    socket.on('profile:joined', (payload: { profile: Profile; presence: Presence }) => {
      setProfile(payload.profile);
      setPresence(payload.presence);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [phase, profile?.profileId, profile?.nickname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPanel('video');
      }
      if (event.key === 'Control') {
        const now = Date.now();
        const last = Number(sessionStorage.getItem('moyu.ctrl.ts') || '0');
        if (now - last < 420) {
          setPanel('video');
        }
        sessionStorage.setItem('moyu.ctrl.ts', String(now));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (phase !== 'app') return;
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 24) return;
      event.preventDefault();
      if (event.deltaY < 0) {
        setPanel('game');
      } else {
        setPanel('video');
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [phase]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, typingName]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.play().catch(() => undefined);
  }, [config?.videoUrl]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await readJson('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(login)
      });
      await bootstrapAfterLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleProfileSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!profileChoice || !config) return;
    setBusy(true);
    setError(null);
    try {
      const target = config.avatarOptions.find((item) => item.id === profileChoice);
      const nextNickname = nickname.trim() || target?.label || profileChoice;
      await readJson('/api/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          profileId: profileChoice,
          nickname: nextNickname
        })
      });
      await loadBootstrap(profileChoice, nextNickname);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建用户失败');
    } finally {
      setBusy(false);
    }
  }

  function emitText() {
    const text = composer.trim();
    if (!text || !socketRef.current) return;
    socketRef.current.emit('chat:send', { kind: 'text', text });
    setComposer('');
    setEmojiOpen(false);
  }

  function sendEmoji(code: string) {
    socketRef.current?.emit('chat:send', { kind: 'emoji', emojiCode: code });
  }

  function sendImageUrl(url: string, text?: string) {
    socketRef.current?.emit('chat:send', {
      kind: 'image',
      imageUrl: url,
      text: text || '图片'
    });
  }

  async function uploadImage(file: File) {
    const form = new FormData();
    form.append('file', file);
    const result = await readJson<{ url: string }>('/api/upload', {
      method: 'POST',
      body: form
    });
    socketRef.current?.emit('chat:send', {
      kind: 'image',
      imageUrl: result.url,
      text: file.name
    });
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await uploadImage(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    }
  }

  async function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    try {
      await uploadImage(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : '粘贴上传失败');
    }
  }

  async function emitAck(eventName: string, payload: Record<string, unknown> = {}) {
    const socket = socketRef.current;
    if (!socket) throw new Error('未连接');
    return await new Promise<{ ok: boolean; error?: string; [key: string]: unknown }>((resolve) => {
      socket.emit(eventName, payload, (response: { ok: boolean; error?: string; [key: string]: unknown }) => {
        resolve(response);
      });
    });
  }

  async function sendMove(row: number, col: number) {
    if (!profile || gameState.winner) return;
    const response = await emitAck('game:move', { row, col });
    if (!response.ok) {
      setError(String(response.error || '落子失败'));
    }
  }

  async function resetGame() {
    const response = await emitAck('game:reset');
    if (!response.ok) {
      setError(String(response.error || '重置失败'));
    }
  }

  async function requestUndo() {
    const response = await emitAck('game:undo:request', {});
    if (!response.ok) {
      setError(String(response.error || '申请悔棋失败'));
    }
  }

  async function answerUndo(accepted: boolean) {
    const response = await emitAck('game:undo:respond', { accepted });
    if (!response.ok) {
      setError(String(response.error || '处理悔棋失败'));
    }
    setPendingUndo(null);
  }

  function renderAvatar(url: string, label: string) {
    return (
      <img className="avatar" src={url} alt={label} />
    );
  }

  function renderMessage(message: Message) {
    const mine = profile?.profileId === message.profileId;
    return (
      <div key={message.id} className={`message-row ${mine ? 'mine' : ''}`}>
        {!mine && renderAvatar(message.avatar, message.nickname)}
        <div className="message-body">
          <div className="message-meta">
            <span className="message-name">{message.nickname}</span>
            <span className="message-time">{formatTime(message.createdAt)}</span>
          </div>
          <div className={bubbleClass(message.kind)}>
            {message.kind === 'text' && <span>{message.text}</span>}
            {message.kind === 'image' && message.imageUrl && <img className="message-image" src={message.imageUrl} alt={message.text || '图片'} />}
            {message.kind === 'emoji' && message.emojiCode && config && (
              <img className="message-emoji" src={config.emojiOptions.find((item) => item.code === message.emojiCode)?.url || ''} alt={message.emojiCode} />
            )}
          </div>
        </div>
        {mine && renderAvatar(message.avatar, message.nickname)}
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="screen screen-loading">
        <div className="loading-card">正在初始化…</div>
      </div>
    );
  }

  if (phase === 'login') {
    return (
      <div className="screen auth-screen">
        <div className="auth-glow" />
        <div className="auth-card">
          <div className="auth-brand">
            {config?.logoUrl && <img src={config.logoUrl} alt="TT Studio" className="auth-logo" />}
            <div>
              <div className="eyebrow">私密双人工作台</div>
              <h1>TT Studio</h1>
              <p>本机测试版 · 账号验证后进入</p>
            </div>
          </div>
          <form onSubmit={handleLogin} className="auth-form">
            <label>
              账号
              <input value={login.account} onChange={(event) => setLogin((prev) => ({ ...prev, account: event.target.value }))} placeholder="输入账号" />
            </label>
            <label>
              密码
              <input value={login.password} onChange={(event) => setLogin((prev) => ({ ...prev, password: event.target.value }))} placeholder="输入密码" type="password" />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? '进入中…' : '登录'}
            </button>
          </form>
          <div className="auth-footnote">提示：登录后会继续选择头像与昵称。</div>
        </div>
      </div>
    );
  }

  if (phase === 'profile') {
    return (
      <div className="screen auth-screen">
        <div className="auth-glow soft" />
        <div className="auth-card profile-card">
          <div className="eyebrow">创建用户信息</div>
          <h1>选一个身份</h1>
          <div className="profile-grid">
            {config?.avatarOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`profile-pick ${profileChoice === item.id ? 'active' : ''}`}
                onClick={() => {
                  setProfileChoice(item.id);
                  setNickname((prev) => prev || item.label);
                }}
              >
                <img src={item.avatar} alt={item.label} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <form onSubmit={handleProfileSubmit} className="auth-form">
            <label>
              昵称
              <input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="默认可不填" />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? '创建中…' : '进入'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="left-rail">
        <div className="brand-row">
          {config?.logoUrl && <img src={config.logoUrl} alt="TT Studio" className="brand-logo" />}
          <div>
            <div className="eyebrow">TT Studio</div>
            <div className="brand-title">工作台</div>
          </div>
        </div>
        <div className="search-box">
          <span>⌕</span>
          <input value="" readOnly placeholder="搜索" />
        </div>
        <nav className="nav-list">
          {['推荐', '探索', '已关注', '好友', '直播', '消息', '活动', '上传', '主页', '更多'].map((item, index) => (
            <button key={item} className={`nav-item ${index === 0 ? 'active' : ''}`} type="button">
              <span className="nav-dot" />
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-card">
          <div className="sidebar-label">在线状态</div>
          <div className="presence-row">
            <span className={`presence-pill ${presence.kuromi ? 'on' : ''}`}>库洛米</span>
            <span className={`presence-pill ${presence.baku ? 'on' : ''}`}>巴库</span>
          </div>
          <div className="mini-hint">Esc 返回视频 · 双击 Ctrl 收回面板</div>
        </div>
      </aside>

      <main className="main-area">
        <div className="top-bar">
          <div>
            <div className="eyebrow">TT Studio</div>
            <div className="top-title">{panel === 'video' ? '视频浏览' : '详情预览'}</div>
          </div>
          <div className="top-meta">
            <span>当前身份：{currentProfileLabel}</span>
            <button className="ghost-button" type="button" onClick={() => setPanel('video')}>视频</button>
            <button className="ghost-button" type="button" onClick={() => setPanel('game')}>详情</button>
          </div>
        </div>

        <section className="stage" ref={stageRef}>
          <div className="video-layer">
            {config?.videoUrl && (
              <video
                ref={videoRef}
                className="video-player"
                src={config.videoUrl}
                autoPlay
                muted
                loop
                playsInline
                controls
              />
            )}
            <div className="video-caption">
              <div className="video-chip">默认视频素材</div>
              <div className="video-title">上滑查看详情，下滑回到视频</div>
              <div className="video-subtitle">本机测试 · 长期保存聊天与棋局</div>
            </div>
          </div>

          <div className={`game-layer ${panel === 'game' ? 'open' : ''}`}>
            <div className="game-shell">
              <div className="game-head">
                <div>
                  <div className="eyebrow">协作预览</div>
                  <div className="game-title">
                    {gameState.winner ? `${gameState.winner === 'black' ? '黑方' : '白方'}获胜` : `${gameState.turn === 'black' ? '黑方' : '白方'}落子`}
                  </div>
                </div>
                <div className="game-actions">
                  <button className="ghost-button" type="button" onClick={() => setPanel('video')}>回视频</button>
                  <button className="ghost-button" type="button" onClick={requestUndo}>申请悔棋</button>
                  <button className="ghost-button" type="button" onClick={resetGame}>重新开始</button>
                </div>
              </div>

              {pendingUndo && (
                <div className="undo-banner">
                  <span>{pendingUndo.fromNickname} 请求悔棋</span>
                  <div className="undo-actions">
                    <button className="ghost-button" type="button" onClick={() => answerUndo(true)}>同意</button>
                    <button className="ghost-button" type="button" onClick={() => answerUndo(false)}>拒绝</button>
                  </div>
                </div>
              )}

              <div className="board-frame">
                <div className="board-grid">
                  {gameState.board.map((row, rowIndex) =>
                    row.map((cell, colIndex) => {
                      const isLast = gameState.lastMove?.row === rowIndex && gameState.lastMove?.col === colIndex;
                      return (
                        <button
                          key={cellKey(rowIndex, colIndex)}
                          className="board-cell"
                          type="button"
                          style={{
                            left: `${(colIndex / 14) * 100}%`,
                            top: `${(rowIndex / 14) * 100}%`
                          }}
                          onClick={() => sendMove(rowIndex, colIndex)}
                        >
                          {cell && <span className={`stone ${cell} ${isLast ? 'last' : ''}`} />}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="game-foot">
                <span>轮到：{gameState.turn === 'black' ? '黑方' : '白方'}</span>
                <span>对局步数：{gameState.moves.length}</span>
                <span>在线：{presence.kuromi ? '库洛米' : '库洛米离线'} · {presence.baku ? '巴库' : '巴库离线'}</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      <aside className="comment-rail">
        <div className="comment-head">
          <div>
            <div className="eyebrow">评论区</div>
            <div className="comment-title">实时互动</div>
          </div>
          <div className="live-pill">Live</div>
        </div>

        <div className="comment-list" ref={listRef}>
          {messages.map(renderMessage)}
          {typingName && <div className="typing-line">{typingName} 正在输入…</div>}
        </div>

        <div className="composer">
          {error && <div className="form-error compact">{error}</div>}
          <div className="composer-toolbar">
            <button className="icon-button" type="button" onClick={() => fileRef.current?.click()}>＋</button>
            <button className="icon-button" type="button" onClick={() => setEmojiOpen((prev) => !prev)}>☺</button>
            <button className="icon-button" type="button" onClick={() => setPanel('game')}>棋</button>
          </div>
          {emojiOpen && config && (
            <div className="emoji-popover">
              {config.emojiOptions.slice(0, 48).map((emoji) => (
                <button
                  key={emoji.code}
                  type="button"
                  className="emoji-item"
                  onClick={() => {
                    sendEmoji(emoji.code);
                    setEmojiOpen(false);
                  }}
                >
                  <img src={emoji.url} alt={emoji.code} />
                  <span>{emoji.code}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            value={composer}
            onChange={(event) => {
              setComposer(event.target.value);
              socketRef.current?.emit('typing', { isTyping: event.target.value.trim().length > 0 });
            }}
            onBlur={() => socketRef.current?.emit('typing', { isTyping: false })}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                emitText();
              }
            }}
            placeholder="添加评论…"
            rows={3}
          />
          <div className="composer-footer">
            <span className="mini-hint">{typingName ? '对方正在输入' : 'Enter 发送 · Shift+Enter 换行'}</span>
            <button className="primary-button small" type="button" onClick={emitText}>发送</button>
          </div>
        </div>

        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFileChange} />
      </aside>
    </div>
  );
}
