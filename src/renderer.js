'use strict';

/**
 * SleePhy UI. Talks to the main process through window.sleephy only.
 * No key material or plaintext crypto happens here.
 */

const api = window.sleephy;

const AVATAR_COLORS = ['mint', 'sky', 'violet', 'amber', 'rose', 'lime', 'cyan', 'coral'];
const SAVED = 'saved'; // pseudo-peer for Saved Messages (really "your own username")

/* ------------------------------- bots --------------------------------- */
// Bots are local pseudo-peers, like Saved Messages: there is no account behind
// them and the relay never hears of them. A bot reply is produced on this
// device, so a bot conversation stays as private as the device itself. Games
// between two real people are different — those moves travel as ordinary
// end-to-end encrypted messages (see `game.*` below), so the relay stays blind.
const GAMES = (typeof window !== 'undefined' && window.SleePhyGames) || null;
const POLLS = (typeof window !== 'undefined' && window.SleePhyPolls) || null;
const FOLDERS = (typeof window !== 'undefined' && window.SleePhyFolders) || null;

const BOT_MINIGAMES = 'minigames';
const BOT_STICKERS = 'stickers';
const BOTS = new Map([
  [BOT_MINIGAMES, {
    id: BOT_MINIGAMES,
    username: BOT_MINIGAMES,
    title: 'Мини-игры',
    subtitle: 'Играйте с ботом или с собеседником',
    color: 'violet',
    greeting: 'Привет! Выберите игру: крестики-нолики, шашки, шахматы или морской бой. Можно сыграть с ботом или отправить вызов собеседнику.'
  }],
  [BOT_STICKERS, {
    id: BOT_STICKERS,
    username: BOT_STICKERS,
    title: 'Стикеры',
    subtitle: 'Пак стикеров SleePhy',
    color: 'amber',
    greeting: 'Держите стикеры! Нажмите на смайлик, чтобы отправить его в чат.'
  }]
]);

function botKey(id) { return `bot:${id}`; }
function isBotKey(key) { return typeof key === 'string' && key.startsWith('bot:'); }
function botIdOf(key) { return String(key).slice('bot:'.length); }
function botFor(key) { return BOTS.get(botIdOf(key)) || null; }
/** A message written by a bot shows on the left, like an incoming message. */
function isBot(username) { return BOTS.has(username); }

/* ---------------------------- games / bots ---------------------------- */
// A game is stored on the chat as `chat.game`. Against a bot the whole game
// lives here; against a person the same object is mirrored from the encrypted
// `game.*` messages that travel over the relay (see the event handler).
//
//   { id, state, seat, opponent, level, started, lastMove, status }
//
// `seat` is this device's side (0 or 1). `opponent` is 'bot' or a username.

const GAME_ICONS = {
  tictactoe: 'i-game-ttt',
  checkers: 'i-game-checkers',
  chess: 'i-game-chess',
  battleship: 'i-game-ships'
};

/** A short, stable signature of a position, to ignore duplicate/echoed moves. */
function gameSignature(game) {
  if (!game || !game.state) return '';
  return GAMES ? GAMES.encode(game.id, game.state) : JSON.stringify(game.state);
}

function gameResult(game) {
  if (!GAMES || !game) return null;
  const g = GAMES.byId(game.id);
  return g ? g.result(game.state) : null;
}

/** Whose turn it is, and whether this device may move right now. */
function gameIsMyTurn(game) {
  return !!game && game.state.turn === game.seat;
}

function gameStatusText(game) {
  const g = GAMES && GAMES.byId(game.id);
  if (!g) return '';
  const res = g.result(game.state);
  if (res) {
    if (res.winner === -1) return 'Ничья';
    return res.winner === game.seat ? 'Вы победили' : 'Вы проиграли';
  }
  if (game.opponent === 'bot') {
    return game.state.turn === game.seat ? 'Ваш ход' : 'Ход бота…';
  }
  return game.state.turn === game.seat ? 'Ваш ход' : 'Ход соперника…';
}

/* ------------------------- bot chat bootstrap ------------------------- */
// The bot chat is created the first time it is opened and its transcript lives
// only on this device (it is never sent anywhere). It reuses the normal chat
// map, so the list, search and unread logic all work unchanged.

function openBotChat(id) {
  const key = botKey(id);
  const bot = BOTS.get(id);
  if (!bot) return;
  const chat = ensureChat(key);
  if (!chat.loaded) {
    chat.messages = [{
      id: 'bot-hello', text: bot.greeting, ts: Date.now(), mine: false, reactions: []
    }];
    chat.last = bot.greeting;
    chat.lastTs = chat.messages[0].ts;
    chat.loaded = true;
  }
  renderChatList();
  openChat(key);
}

/** Append a message to a chat as if it came from the bot, then repaint. */
function pushBotMessage(key, text, extra) {
  const chat = ensureChat(key);
  const m = Object.assign({
    id: 'bot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    text, ts: Date.now(), mine: false, reactions: []
  }, extra || {});
  chat.messages.push(m);
  chat.last = m.kind ? (m.kind === 'image' ? 'Фото' : m.kind) : text;
  chat.lastTs = m.ts;
  if (state.activePeer === key) renderMessages();
  renderChatList();
  return m;
}

/** Answer a plain text message sent to a bot. */
function botReply(key, text, chat) {
  const id = botIdOf(key);
  const lower = String(text).toLowerCase();
  if (id === BOT_MINIGAMES) {
    const game = GAMES && GAMES.GAMES.find((g) => lower.includes(g.id) || lower.includes(g.name.toLowerCase()));
    if (game) {
      // Ask for a game by name, e.g. "шахматы" or "chess".
      setTimeout(() => {
        if (state.activePeer === key) startGameWithBot(game.id);
      }, 250);
      return;
    }
    setTimeout(() => pushBotMessage(key,
      'Напишите название игры — крестики-нолики, шашки, шахматы или морской бой — или откройте панель «Игры» под полем ввода.'), 300);
    return;
  }
  if (id === BOT_STICKERS) {
    setTimeout(() => pushBotMessage(key,
      'Откройте панель «Стикеры» под полем ввода и выберите любой — он отправится как изображение.'), 300);
    return;
  }
  setTimeout(() => pushBotMessage(key, 'Понял!'), 300);
}

/* ---------------------------- game menu ---------------------------- */

function buildGamePanel() {
  els.gameGrid.innerHTML = '';
  for (const game of (GAMES ? GAMES.GAMES : [])) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'game-card';
    card.dataset.game = game.id;
    card.innerHTML = `
      <span class="game-card-ico">${icon(GAME_ICONS[game.id] || 'i-dice')}</span>
      <span class="game-card-name">${escapeHtml(game.name)}</span>
    `;
    card.addEventListener('click', () => {
      els.emojiPanel.hidden = true;
      const key = state.activePeer;
      if (isBotKey(key) && botIdOf(key) === BOT_MINIGAMES) startGameWithBot(game.id);
      else startGameWithPeer(game.id);
    });
    els.gameGrid.appendChild(card);
  }
}

/**
 * Invite the person in the open chat to a game. The invite is an ordinary
 * encrypted message carrying an empty position, so the relay stays blind and
 * the peer's device adopts the game the moment it arrives.
 */
async function startGameWithPeer(gameId) {
  const key = state.activePeer;
  if (!key || isBotKey(key) || isGroupKey(key) || isChannelKey(key) || key === SAVED) {
    toast('Откройте личный чат, чтобы пригласить в игру');
    return;
  }
  const g = GAMES && GAMES.byId(gameId);
  if (!g) return;
  let st = g.create();
  if (gameId === 'battleship') st = GAMES.setFleet(st, 0);
  const chat = ensureChat(key);
  chat.game = {
    id: gameId, state: st, seat: 0, opponent: key,
    started: Date.now(), lastMove: null, status: 'play', sel: null
  };
  renderMessagesImmediate();
  renderChatList();
  const payload = JSON.stringify({ g: gameId, s: GAMES.encode(gameId, st), seat: 0, status: 'play' });
  try {
    await api.send({ to: peerUsername(key), text: payload });
    noteLocalSend();
  } catch (err) {
    toast(err.message || 'Не удалось отправить приглашение');
  }
}

/** Begin (or restart) a game against the bot in the open bot chat. */
function startGameWithBot(gameId) {
  const key = state.activePeer;
  if (!isBotKey(key) || botIdOf(key) !== BOT_MINIGAMES) return;
  const g = GAMES && GAMES.byId(gameId);
  if (!g) return;
  let st = g.create();
  // Battleship: place this device's fleet (seat 0 in a bot game).
  if (gameId === 'battleship') st = GAMES.setFleet(st, 0);
  const chat = ensureChat(key);
  chat.game = {
    id: gameId, state: st, seat: 0, opponent: 'bot', level: 2,
    started: Date.now(), lastMove: null, status: 'play'
  };
  pushBotMessage(key, `Игра: ${g.name}. Вы играете первым.`);
  renderMessagesImmediate();
  // If the bot opens (never, seat 0 opens) keep the guard anyway.
  maybeBotMove(chat.game);
}

/** Let the bot answer when it is its turn. */
function maybeBotMove(game) {
  if (!game || game.opponent !== 'bot' || game.status !== 'play') return;
  if (game.state.turn === game.seat) return;
  const g = GAMES.byId(game.id);
  const move = g.bot(game.state, game.level);
  if (move == null) return;
  // A short pause so the reply feels like an opponent, not a local computation.
  setTimeout(() => {
    if (game.status !== 'play') return;
    game.state = g.apply(game.state, move);
    game.lastMove = { seat: 1 - game.seat, move };
    const res = g.result(game.state);
    if (res) game.status = 'done';
    renderMessagesImmediate();
    renderChatList();
  }, 420);
}

/* --------------------------- playing a move --------------------------- */

/** A click on the board: validate it, apply it, and hand over if needed. */
function playMove(move) {
  const key = state.activePeer;
  const chat = state.chats.get(key);
  const game = chat && chat.game;
  if (!game || game.status !== 'play') return;
  if (!gameIsMyTurn(game)) return;
  const g = GAMES.byId(game.id);
  const legal = g.moves(game.state);
  const ok = legal.some((m) => gameMoveEquals(game.id, m, move));
  if (!ok) return;

  game.state = g.apply(game.state, move);
  game.lastMove = { seat: game.seat, move };
  const res = g.result(game.state);
  if (res) game.status = 'done';
  renderMessagesImmediate();
  renderChatList();

  if (game.status !== 'play') return;
  if (game.opponent === 'bot') {
    maybeBotMove(game);
  } else {
    // Send the whole position, encrypted, to the peer. The position is the
    // source of truth, so a lost or reordered message cannot desync the game.
    sendGameState(game);
  }
}

function gameMoveEquals(id, a, b) {
  // A tic-tac-toe move is a cell index, and cell 0 is falsy, so compare against
  // null rather than truthiness.
  if (a == null || b == null) return false;
  if (id === 'tictactoe') return a === b;
  if (id === 'battleship') return a[0] === b[0] && a[1] === b[1];
  return JSON.stringify(a.from) === JSON.stringify(b.from) && JSON.stringify(a.to) === JSON.stringify(b.to)
    && (a.promo || '') === (b.promo || '');
}

/** Send the current position to a peer as one encrypted message. */
async function sendGameState(game) {
  const key = state.activePeer;
  if (!key || game.opponent === 'bot') return;
  const payload = JSON.stringify({
    g: game.id, s: GAMES.encode(game.id, game.state),
    seat: game.seat, status: game.status
  });
  try {
    await api.send({ to: peerUsername(key), text: payload });
  } catch (err) {
    toast(err.message || 'Не удалось отправить ход');
  }
}

/* --------------------------- game rendering --------------------------- */

/**
 * Adopt a position that arrived from a peer. The payload carries the sender's
 * seat, so the local seat is the other one. The payload is the whole position,
 * not a delta, so the newest message always leaves both devices agreeing — a
 * replayed or reordered message cannot desync the game.
 */
function applyPeerGame(chat, from, payload) {
  const g = GAMES && GAMES.byId(payload.g);
  if (!g) return;
  const seat = payload.seat === 0 ? 1 : 0;
  let position;
  try { position = GAMES.decode(payload.g, payload.s); } catch { return; }
  if (chat.game && gameSignature(chat.game) === payload.s) return;
  chat.game = {
    id: payload.g,
    state: position,
    seat,
    opponent: from,
    started: (chat.game && chat.game.started) || Date.now(),
    lastMove: (chat.game && chat.game.lastMove) || null,
    status: payload.status === 'done' ? 'done' : 'play',
    sel: null
  };
  chat.last = `Игра: ${g.name}`;
  chat.lastTs = Date.now();
  if (state.activePeer === chat.key) renderMessagesImmediate();
  renderChatList();
}

/** The game position carried by a message, or null for ordinary text. */
function gamePayloadOf(m) {
  if (!m || !m.text || m.text[0] !== '{') return null;
  try {
    const obj = JSON.parse(m.text);
    if (obj && obj.g && typeof obj.s === 'string') return obj;
  } catch { /* not a game payload */ }
  return null;
}

function renderGameBoard(game) {
  const g = GAMES && GAMES.byId(game.id);
  if (!g) return '';
  const wrap = document.createElement('div');
  wrap.className = 'game-board';
  const head = document.createElement('div');
  head.className = 'game-board-head';
  head.innerHTML = `<span class="game-board-title">${escapeHtml(g.name)}</span>
    <span class="game-board-status">${escapeHtml(gameStatusText(game))}</span>`;
  wrap.appendChild(head);

  const canPlay = game.status === 'play' && gameIsMyTurn(game);
  const body = game.id === 'tictactoe' ? tttBoard(game, canPlay)
    : game.id === 'checkers' ? draughtsBoard(game, canPlay)
      : game.id === 'chess' ? chessBoard(game, canPlay)
        : battleshipBoards(game, canPlay);
  wrap.appendChild(body);

  const res = g.result(game.state);
  if (game.status !== 'play' || res) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn-secondary btn-compact';
    again.textContent = 'Играть снова';
    again.addEventListener('click', () => restartGame(game));
    wrap.appendChild(again);
  }
  return wrap;
}

function restartGame(game) {
  const g = GAMES.byId(game.id);
  let st = g.create();
  if (game.id === 'battleship') st = GAMES.setFleet(st, game.seat);
  game.state = st;
  game.status = 'play';
  game.lastMove = null;
  renderMessagesImmediate();
  renderChatList();
  if (game.opponent === 'bot') maybeBotMove(game);
  else sendGameState(game);
}

function tttBoard(game, canPlay) {
  const grid = document.createElement('div');
  grid.className = 'ttt-grid';
  const res = GAMES.byId('tictactoe').result(game.state);
  const winLine = res && res.winner >= 0 ? tttWinLine(game.state.cells, res.winner) : [];
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'ttt-cell';
    cell.dataset.cell = String(i);
    const v = game.state.cells[i];
    cell.textContent = v == null ? '' : (v === 0 ? '✕' : '◯');
    if (v != null) cell.disabled = true;
    if (winLine.includes(i)) cell.classList.add('win');
    if (canPlay && v == null) cell.addEventListener('click', () => playMove(i));
    grid.appendChild(cell);
  }
  return grid;
}

/** The three cells of the line that won, for highlighting. */
function tttWinLine(cells, player) {
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  return lines.find(([a, b, c]) => cells[a] === player && cells[b] === player && cells[c] === player) || [];
}

function draughtsBoard(game, canPlay) {
  const grid = document.createElement('div');
  grid.className = 'checkers-grid';
  const moves = canPlay ? GAMES.byId('checkers').moves(game.state) : [];
  const targets = new Set(moves.map((m) => m.to.join(',')));
  const last = game.lastMove && game.lastMove.move;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'checkers-cell ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      const v = game.state.board[r][c];
      cell.textContent = v === 1 || v === 3 ? '●' : v === 2 || v === 4 ? '♛' : '';
      if (v === 1 || v === 2) cell.style.color = '#e8eef6';
      if (v === 3 || v === 4) cell.style.color = '#1a2530';
      if (targets.has(r + ',' + c)) cell.classList.add('move');
      if (last && JSON.stringify(last.from) === JSON.stringify([r, c])) cell.classList.add('last');
      if (canPlay && v !== 0 && ((game.seat === 0 && (v === 1 || v === 2)) || (game.seat === 1 && (v === 3 || v === 4)))) {
        cell.addEventListener('click', () => selectDraughts(game, [r, c]));
      }
      grid.appendChild(cell);
    }
  }
  return grid;
}

// Draughts needs two clicks (from, then to). The first click records the piece
// on the game object so the next paint can highlight its destinations.
function selectDraughts(game, from) {
  game.sel = from;
  const moves = GAMES.byId('checkers').moves(game.state)
    .filter((m) => m.from[0] === from[0] && m.from[1] === from[1]);
  if (moves.length === 1 && moves[0].captures && moves[0].captures.length > 0) {
    playMove(moves[0]);
    return;
  }
  renderMessagesImmediate();
}

function chessBoard(game, canPlay) {
  const grid = document.createElement('div');
  grid.className = 'chess-grid';
  const moves = canPlay ? GAMES.byId('chess').moves(game.state) : [];
  const from = game.sel;
  const targets = new Set(moves.filter((m) => from && m.from[0] === from[0] && m.from[1] === from[1]).map((m) => m.to.join(',')));
  const GLYPH = {
    K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
  };
  const last = game.lastMove && game.lastMove.move;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'chess-cell ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      const p = game.state.board[r][c];
      cell.textContent = p ? GLYPH[p] || '' : '';
      if (p && p === p.toUpperCase()) cell.style.color = '#f1f5f9';
      if (p && p === p.toLowerCase()) cell.style.color = '#101a23';
      if (from && from[0] === r && from[1] === c) cell.classList.add('sel');
      if (targets.has(r + ',' + c)) cell.classList.add('move');
      if (last && JSON.stringify(last.to) === JSON.stringify([r, c])) cell.classList.add('last');
      if (canPlay) cell.addEventListener('click', () => clickChess(game, [r, c]));
      grid.appendChild(cell);
    }
  }
  return grid;
}

function clickChess(game, square) {
  const moves = GAMES.byId('chess').moves(game.state);
  const from = game.sel;
  if (from) {
    const candidates = moves.filter((m) => m.from[0] === from[0] && m.from[1] === from[1]
      && m.to[0] === square[0] && m.to[1] === square[1]);
    if (candidates.length === 1) { playMove(candidates[0]); game.sel = null; return; }
    if (candidates.length > 1) {
      // Promotion: default to a queen, the near-universal choice.
      playMove(candidates.find((m) => m.promo === 'q') || candidates[0]);
      game.sel = null;
      return;
    }
  }
  const mine = moves.some((m) => m.from[0] === square[0] && m.from[1] === square[1]);
  game.sel = mine ? square : null;
  renderMessagesImmediate();
}

function battleshipBoards(game, canPlay) {
  const wrap = document.createElement('div');
  wrap.className = 'bs-grids';
  const myFleet = game.state.fleets[game.seat];
  const enemySeat = 1 - game.seat;
  const enemyShots = game.state.shots[enemySeat]; // squares I fired at
  const enemyFleet = game.state.fleets[enemySeat];

  wrap.appendChild(bsGrid('Ваше поле', (r, c) => {
    const v = myFleet ? myFleet.grid[r][c] : null;
    const shot = game.state.shots[game.seat][r][c];
    if (shot === 'hit') return { cls: 'hit', text: '✕' };
    if (shot === 'miss') return { cls: 'miss', text: '·' };
    if (v != null) return { cls: 'ship', text: '' };
    return { cls: '', text: '' };
  }, null));

  wrap.appendChild(bsGrid('Поле соперника', (r, c) => {
    const shot = enemyShots[r][c];
    if (shot === 'hit') return { cls: 'hit', text: '✕' };
    if (shot === 'miss') return { cls: 'miss', text: '·' };
    const sunk = enemyFleet && enemyFleet.grid[r][c] != null;
    return { cls: '', text: '' };
  }, canPlay && game.state.ready[enemySeat] ? (r, c) => {
    if (enemyShots[r][c] != null) return;
    playMove([r, c]);
  } : null));

  return wrap;
}

function bsGrid(label, cellFn, clickFn) {
  const box = document.createElement('div');
  const cap = document.createElement('div');
  cap.className = 'bs-label';
  cap.textContent = label;
  const grid = document.createElement('div');
  grid.className = 'bs-grid';
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const info = cellFn(r, c);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'bs-cell' + (info.cls ? ' ' + info.cls : '');
      cell.textContent = info.text;
      if (info.cls === 'hit' || info.cls === 'miss') cell.disabled = true;
      if (clickFn) cell.addEventListener('click', () => clickFn(r, c));
      grid.appendChild(cell);
    }
  }
  box.appendChild(cap);
  box.appendChild(grid);
  return box;
}

/* --------------------------- element helpers --------------------------- */
const $ = (id) => document.getElementById(id);

const els = {
  screens: { auth: $('screen-auth'), unlock: $('screen-unlock'), main: $('screen-main') },
  formAuth: $('form-auth'),
  authTabs: $('auth-tabs'),
  tabs: Array.from(document.querySelectorAll('.auth-tab')),
  authUser: $('auth-username'),
  authPass: $('auth-password'),
  authConfirm: $('auth-confirm'),
  fieldConfirm: $('field-confirm'),
  authHint: $('auth-hint'),
  authError: $('auth-error'),
  btnAuth: $('btn-auth'),
  phoneFlow: $('auth-phone-flow'),
  btnPhoneSignin: $('btn-phone-signin'),
  formPhone: $('form-phone'),
  authPhone: $('auth-phone'),
  authPhoneHint: $('auth-phone-hint'),
  authPhoneError: $('auth-phone-error'),
  btnPhone: $('btn-phone'),
  stepPhone: $('auth-step-phone'),
  stepCode: $('auth-step-code'),
  formCode: $('form-code'),
  authCode: $('auth-code'),
  authCodeHint: $('auth-code-hint'),
  authCodeError: $('auth-code-error'),
  btnCode: $('btn-code'),
  btnCodeBack: $('btn-code-back'),
  serverUrl: $('server-url'),
  authConn: $('auth-conn'),

  formUnlock: $('form-unlock'),
  unlockPass: $('unlock-password'),
  unlockError: $('unlock-error'),
  unlockUser: $('unlock-user'),
  btnSwitch: $('btn-switch-account'),

  btnMyProfile: $('btn-my-profile'),
  meName: $('me-name'),
  meAvatar: $('me-avatar'),
  meState: $('me-state'),
  meStreak: $('me-streak'),
  meStreakCount: $('me-streak-count'),
  search: $('search'),
  btnSearchClear: $('btn-search-clear'),
  searchPanel: $('search-panel'),
  searchResults: $('search-results'),
  searchEmpty: $('search-empty'),
  chatSections: $('chat-sections'),
  chatList: $('chat-list'),
  chatEmpty: $('chat-empty'),
  sectionArchived: $('section-archived'),
  btnArchivedToggle: $('btn-archived-toggle'),
  archivedList: $('archived-list'),
  archivedCount: $('archived-count'),
  btnSettings: $('btn-settings'),
  btnMenu: $('btn-menu'),
  drawer: $('drawer'),
  drawerBackdrop: $('drawer-backdrop'),
  drawerAvatar: $('drawer-avatar'),
  drawerName: $('drawer-name'),
  drawerHandle: $('drawer-handle'),
  drawerAccountsCount: $('drawer-accounts-count'),
  drawerArchivedCount: $('drawer-archived-count'),
  drawerVer: $('drawer-ver'),
  footVer: $('foot-ver'),
  accountsBackdrop: $('accounts-backdrop'),
  accountsList: $('accounts-list'),
  btnAccountsClose: $('btn-accounts-close'),
  botsBackdrop: $('bots-backdrop'),
  botsList: $('bots-list'),
  btnBotsClose: $('btn-bots-close'),
  giftsBackdrop: $('gifts-backdrop'),
  giftsGrid: $('gifts-grid'),
  giftsNote: $('gifts-note'),
  btnGiftsClose: $('btn-gifts-close'),
  pollBackdrop: $('poll-backdrop'),
  pollQuestion: $('poll-question'),
  pollOptions: $('poll-options'),
  pollMultiple: $('poll-multiple'),
  pollAnon: $('poll-anon'),
  pollError: $('poll-error'),
  btnPollAdd: $('btn-poll-add'),
  btnPollCreate: $('btn-poll-create'),
  btnPollClose: $('btn-poll-close'),
  folderTabs: $('folder-tabs'),
  folderBackdrop: $('folder-backdrop'),
  folderList: $('folder-list'),
  folderEmpty: $('folder-empty'),
  btnFolderNew: $('btn-folder-new'),
  folderEditor: $('folder-editor'),
  folderName: $('folder-name'),
  folderKinds: $('folder-kinds'),
  folderUnread: $('folder-unread'),
  folderExclusive: $('folder-exclusive'),
  folderError: $('folder-error'),
  btnFolderSave: $('btn-folder-save'),
  btnFolderDelete: $('btn-folder-delete'),
  btnFolderClose: $('btn-folder-close'),
  btnAccountsAdd: $('btn-accounts-add'),
  contactsBackdrop: $('contacts-backdrop'),
  contactsList: $('contacts-list'),
  contactsEmpty: $('contacts-empty'),
  contactInput: $('contact-input'),
  btnContactAdd: $('btn-contact-add'),
  contactError: $('contact-error'),
  btnContactsClose: $('btn-contacts-close'),
  groupBackdrop: $('group-backdrop'),
  groupName: $('group-name'),
  groupMembers: $('group-members'),
  groupError: $('group-error'),
  btnGroupCreate: $('btn-group-create'),
  btnGroupClose: $('btn-group-close'),
  channelBackdrop: $('channel-backdrop'),
  channelName: $('channel-name'),
  channelHandle: $('channel-handle'),
  channelDesc: $('channel-desc'),
  channelError: $('channel-error'),
  btnChannelCreate: $('btn-channel-create'),
  btnChannelClose: $('btn-channel-close'),
  chsetBackdrop: $('chset-backdrop'),
  chsetAvatar: $('chset-avatar'),
  chsetNameLabel: $('chset-name-label'),
  chsetHandleLabel: $('chset-handle-label'),
  chsetName: $('chset-name'),
  chsetHandle: $('chset-handle'),
  chsetDesc: $('chset-desc'),
  chsetError: $('chset-error'),
  chsetSubs: $('chset-subs'),
  btnChsetSave: $('btn-chset-save'),
  btnChsetDelete: $('btn-chset-delete'),
  btnChsetClose: $('btn-chset-close'),
  menuChannelSettings: $('menu-channel-settings'),
  menuChannelLink: $('menu-channel-link'),
  discoverBackdrop: $('discover-backdrop'),
  discoverList: $('discover-list'),
  discoverEmpty: $('discover-empty'),
  discoverSearch: $('discover-search'),
  btnDiscoverClose: $('btn-discover-close'),
  btnDiscoverCreate: $('btn-discover-create'),
  createBackdrop: $('create-backdrop'),
  btnCreateClose: $('btn-create-close'),
  createAccount: $('create-account'),
  createGroup: $('create-group'),
  createChannel: $('create-channel'),
  setNotify: $('set-notify'),
  setPreview: $('set-preview'),
  setSound: $('set-sound'),
  setLastSeen: $('set-lastseen'),
  setHideProfile: $('set-hide-profile'),
  setReceipts: $('set-receipts'),
  setAutoLock: $('set-autolock'),
  setBlockedSub: $('set-blocked-sub'),
  btnBlocked: $('btn-blocked'),
  setPasswordSub: $('set-password-sub'),
  btnSetPassword: $('btn-set-password'),
  formPassword: $('form-password'),
  setPasswordInput: $('set-password-input'),
  setPasswordConfirm: $('set-password-confirm'),
  setPasswordError: $('set-password-error'),
  btnPasswordCancel: $('btn-password-cancel'),
  setAutoPhoto: $('set-autophoto'),
  setKeepMedia: $('set-keepmedia'),
  setStorage: $('set-storage'),
  btnClearCache: $('btn-clear-cache'),
  setEnter: $('set-enter'),
  setLanguage: $('set-language'),

  chatBlank: $('chat-blank'),
  chatView: $('chat-view'),
  btnPeerProfile: $('btn-peer-profile'),
  peerName: $('peer-name'),
  peerAvatar: $('peer-avatar'),
  peerSub: $('peer-sub'),
  btnChatMenu: $('btn-chat-menu'),
  messages: $('messages'),
  composer: $('composer'),
  composerInput: $('composer-input'),
  replyBar: $('reply-bar'),
  replyBarTitle: $('reply-bar-title'),
  replyBarText: $('reply-bar-text'),
  btnReplyCancel: $('btn-reply-cancel'),
  editBar: $('edit-bar'),
  editBarText: $('edit-bar-text'),
  btnEditCancel: $('btn-edit-cancel'),

  profileBackdrop: $('profile-backdrop'),
  profileTitle: $('profile-title'),
  btnProfileClose: $('btn-profile-close'),
  profileAvatar: $('profile-avatar'),
  profileDisplay: $('profile-display'),
  profileHandle: $('profile-handle'),
  profilePresence: $('profile-presence'),
  profileStreak: $('profile-streak'),
  profileStreakText: $('profile-streak-text'),
  profileView: $('profile-view'),
  profileViewUsername: $('profile-view-username'),
  profileViewBio: $('profile-view-bio'),
  profilePubkey: $('profile-pubkey'),
  profileActions: $('profile-actions'),
  btnProfileMessage: $('btn-profile-message'),
  btnProfileEdit: $('btn-profile-edit'),
  profileForm: $('profile-form'),
  avatarPreview: $('avatar-preview'),
  btnAvatarPick: $('btn-avatar-pick'),
  btnAvatarClear: $('btn-avatar-clear'),
  avatarHint: $('avatar-hint'),
  profileName: $('profile-name'),
  profileBio: $('profile-bio'),
  profileColors: $('profile-colors'),
  profileSocialRows: $('profile-social-rows'),
  profileSocialNetwork: $('profile-social-network'),
  profileSocialUrl: $('profile-social-url'),
  btnSocialAdd: $('btn-social-add'),
  profileSocials: $('profile-socials'),
  profileNicknames: $('profile-nicknames'),
  nicknamesField: $('nicknames-field'),
  profileNicknameRows: $('profile-nickname-rows'),
  profileNicknameInput: $('profile-nickname-input'),
  btnNicknameAdd: $('btn-nickname-add'),
  nicknamesHint: $('nicknames-hint'),
  profileError: $('profile-error'),
  btnProfileCancel: $('btn-profile-cancel'),
  usernameSep: $('username-sep'),
  usernameBlock: $('username-block'),
  usernameInput: $('username-input'),
  usernameError: $('username-error'),
  btnUsernameSave: $('btn-username-save'),

  settingsBackdrop: $('settings-backdrop'),
  btnSettingsClose: $('btn-settings-close'),
  setUsername: $('set-username'),
  btnOpenMyProfile: $('btn-open-my-profile'),
  btnOpenSaved: $('btn-open-saved'),
  setConn: $('set-conn'),
  setConnDot: $('set-conn-dot'),
  setServer: $('set-server'),
  btnApplyServer: $('btn-apply-server'),
  setPubkey: $('set-pubkey'),
  btnLogout: $('btn-logout'),

  chatmenuBackdrop: $('chatmenu-backdrop'),
  chatmenuTitle: $('chatmenu-title'),
  chatmenuBody: $('chatmenu-body'),
  btnChatmenuClose: $('btn-chatmenu-close'),
  menuPinLabel: $('menu-pin-label'),
  menuMuteLabel: $('menu-mute-label'),
  menuArchiveLabel: $('menu-archive-label'),
  menuLeave: $('menu-leave'),
  menuLeaveLabel: $('menu-leave-label'),
  menuDelete: $('menu-delete'),

  ctxBackdrop: $('ctx-backdrop'),
  ctxMenu: $('ctx-menu'),
  ctxEdit: $('ctx-edit'),
  ctxDelete: $('ctx-delete'),
  ctxPin: $('ctx-pin'),
  ctxPinLabel: $('ctx-pin-label'),
  ctxReactions: $('ctx-reactions'),
  ctxForward: $('ctx-forward'),

  btnChatSearch: $('btn-chat-search'),
  chatSearchBar: $('chat-search-bar'),
  chatSearchInput: $('chat-search-input'),
  chatSearchCount: $('chat-search-count'),
  btnChatSearchClose: $('btn-chat-search-close'),

  pinnedBar: $('pinned-bar'),
  pinnedTitle: $('pinned-title'),
  pinnedText: $('pinned-text'),
  btnPinnedUnpin: $('btn-pinned-unpin'),

  btnAttach: $('btn-attach'),
  btnEmoji: $('btn-emoji'),
  btnVoice: $('btn-voice'),
  attachBackdrop: $('attach-backdrop'),
  attachMenu: $('attach-menu'),
  emojiPanel: $('emoji-panel'),
  emojiTabs: $('emoji-tabs'),
  emojiGrid: $('emoji-grid'),

  btnThemeToggle: $('btn-theme-toggle'),
  setThemeSub: $('set-theme-sub'),
  wallpaperPicker: $('wallpaper-picker'),

  forwardBackdrop: $('forward-backdrop'),
  forwardList: $('forward-list'),
  forwardEmpty: $('forward-empty'),
  btnForwardClose: $('btn-forward-close'),

  selectBar: $('select-bar'),
  selectCount: $('select-count'),
  btnSelectCancel: $('btn-select-cancel'),
  btnSelectForward: $('btn-select-forward'),
  btnSelectDelete: $('btn-select-delete'),

  confirmBackdrop: $('confirm-backdrop'),
  confirmText: $('confirm-text'),
  btnConfirmYes: $('btn-confirm-yes'),
  btnConfirmNo: $('btn-confirm-no'),
  confirmTitle: $('confirm-title'),
  promptBackdrop: $('prompt-backdrop'),
  promptTitle: $('prompt-title'),
  promptLabel: $('prompt-label'),
  promptInput: $('prompt-input'),
  btnPromptOk: $('btn-prompt-ok'),
  btnPromptCancel: $('btn-prompt-cancel'),
  badgeBackdrop: $('badge-backdrop'),
  badgeDrop: $('badge-drop'),
  badgePreview: $('badge-preview'),
  badgePreviewImg: $('badge-preview-img'),
  badgeDropHint: $('badge-drop-hint'),
  badgeError: $('badge-error'),
  btnBadgeSave: $('btn-badge-save'),
  btnBadgeRemove: $('btn-badge-remove'),
  btnBadgeCancel: $('btn-badge-cancel'),

  meBadge: $('me-badge'),
  peerBadge: $('peer-badge'),
  profileBadge: $('profile-badge'),

  settingsNav: $('settings-nav'),
  settingsPanes: $('settings-panes'),
  setHeroAvatar: $('set-hero-avatar'),
  setHeroName: $('set-hero-name'),
  setAccountHandle: $('set-account-handle'),
  setVersionSub: $('set-version-sub'),
  setChatPreview: $('set-chatpreview'),
  setReduceMotion: $('set-reducemotion'),
  setEscClose: $('set-escclose'),
  setPlainPaste: $('set-plainpaste'),
  btnTestSound: $('btn-test-sound'),
  btnReconnect: $('btn-reconnect'),
  btnCheckUpdates: $('btn-check-updates'),
  btnResetSettings: $('btn-reset-settings'),
  settingsNavAdmin: $('settings-nav-admin'),
  adminStats: $('admin-stats'),
  adminUsers: $('admin-users'),
  adminUsersEmpty: $('admin-users-empty'),
  adminUsersCount: $('admin-users-count'),
  adminUsersSearch: $('admin-users-search'),
  adminChannels: $('admin-channels'),
  adminChannelsEmpty: $('admin-channels-empty'),
  adminChannelsCount: $('admin-channels-count'),
  adminChannelsSearch: $('admin-channels-search'),
  btnAdminRefresh: $('btn-admin-refresh'),
  adminAnnounceInput: $('admin-announce-input'),
  btnAdminAnnounce: $('btn-admin-announce'),

  panelSwitch: $('panel-switch'),
  emojiMode: $('emoji-mode'),
  stickerMode: $('sticker-mode'),
  stickerGrid: $('sticker-grid'),
  gamesMode: $('games-mode'),
  gameGrid: $('game-grid'),

  toast: $('toast')
};

/* ------------------------------- state ------------------------------- */
const state = {
  mode: 'login', // login | register
  username: null,
  profile: null,
  online: false,
  unlocked: false,
  activePeer: null,
  chats: new Map(), // peerKey -> chat
  profiles: new Map(), // username -> profile
  presence: new Map(), // username -> bool
  lastSeen: new Map(), // username -> timestamp when last online
  typing: new Map(), // username -> timeout id
  replyTo: null, // { id, text, from, mine }
  editing: null, // { id, original }
  ctxTarget: null, // { id, mine, text, pinned }
  profileTarget: null, // username being shown
  editingProfile: false,
  searchQuery: '', // active in-chat search
  searchHits: [],
  searchIndex: -1,
  forceScrollBottom: false, // jump to the newest message on the next paint
  settings: { theme: 'dark', wallpaper: 'none' },
  streak: null, // { count, active } for the signed-in account, the "огонёк"
  groups: new Map(), // groupId -> { id, name, owner, members: [] }
  channels: new Map(), // channelId -> { id, name, owner, subs, verified, ... }
  contacts: [], // usernames saved as contacts
  accounts: [], // [{ username, publicKey, active }]
  recording: null, // MediaRecorder state for voice notes
  selecting: null, // Set of message ids while in select mode
  isAdmin: false, // whether the signed-in account may open the admin panel
  adminUsers: [], // last admin user list, filtered client-side by the search box
  adminChannels: [], // last admin channel list, filtered client-side
  adminAnnounceCount: 0,
  settingsPane: 'account', // active settings section
  drafts: {}, // peerKey -> unsent composer text, mirrored into account settings
  draftSaveTimer: null, // coalesces keystrokes into one settings write
  folders: [], // chat folders ("папки"), mirrored into account settings
  activeFolder: 'all', // id of the selected folder tab
  folderEditing: null // id of the folder open in the editor, or 'new'
};


/* ------------------------------ utilities ------------------------------ */
function showScreen(name) {
  for (const [key, el] of Object.entries(els.screens)) el.classList.toggle('active', key === name);
}

function showError(el, message) {
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  // Errors arrive from the main process as plain English sentences. Run them
  // through the dictionary so the user reads them in their own language; a
  // phrase with no entry comes back unchanged.
  el.textContent = i18n.t(message);
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

let toastTimer = null;
function toast(message, duration = 2600, kind) {
  els.toast.className = 'toast' + (kind ? ` toast-${kind}` : '');
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }, duration);
}

/** Deliver a new message alert, honouring the notification settings. */
function notifyNewMessage(from, text) {
  if (state.settings.notify === false) return;
  const body = state.settings.notifyPreview === false
    ? 'New message'
    : (text || 'Attachment').slice(0, 120);
  const title = displayNameFor(from);
  toast(`${title}: ${body}`);
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, silent: state.settings.notifySound === false });
    }
  } catch { /* notifications are best effort */ }
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Russian plural form: 1 участник, 2 участника, 5 участников. */
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** "был(а) в сети …" text for a last-seen timestamp, or null when unknown. */
function lastSeenLabel(ts) {
  if (!ts) return null;
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60000) return 'только что';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} ${plural(mins, 'минуту', 'минуты', 'минут')} назад`;
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return `сегодня в ${timeLabel(ts)}`;
  if (d.toDateString() === yest.toDateString()) return `вчера в ${timeLabel(ts)}`;
  const days = Math.floor(diff / 86400000);
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** Subtitle for a peer: online, or when they were last seen. */
function peerPresenceText(username) {
  if (state.presence.get(username)) return 'в сети';
  const seen = lastSeenLabel(state.lastSeen.get(username));
  return seen ? `был(а) ${seen}` : null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// A username is typed and shown as `@alice`, but stored bare. This is the one
// place that decides what a name is, so every field and validator agrees.
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
function bareUsername(value) {
  return String(value == null ? '' : value).trim().replace(/^@+/, '').toLowerCase();
}
/** `alice` -> `@alice`, for display. */
function atUsername(value) {
  const bare = bareUsername(value);
  return bare ? '@' + bare : '';
}

// `@name` inside message text, so it can be styled and clicked. Usernames are
// 3-32 of a-z 0-9 _, so a mention ends at the first character outside that set.
const MENTION_RE = /@([a-z0-9_]{3,32})/gi;
/** Escape message text, then turn `@name` into a clickable mention span. */
function messageTextHtml(text) {
  return escapeHtml(text).replace(MENTION_RE, (whole, name) =>
    `<span class="mention" data-username="${escapeHtml(name.toLowerCase())}">${whole}</span>`);
}

/** Reference an icon from the sprite declared at the top of index.html. */
function icon(id, cls) {
  return `<svg class="ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

function chatKey(peer) {
  return peer === state.username ? SAVED : peer;
}

/** Group chats use the key "group:<id>" so they can share the chat map. */
function groupKey(groupId) { return `group:${groupId}`; }
function isGroupKey(key) { return typeof key === 'string' && key.startsWith('group:'); }
function groupIdOf(key) { return Number(String(key).slice('group:'.length)); }

/** Channel chats use the key "channel:<id>", same idea as groups. */
function channelKey(channelId) { return `channel:${channelId}`; }
function isChannelKey(key) { return typeof key === 'string' && key.startsWith('channel:'); }
function channelIdOf(key) { return Number(String(key).slice('channel:'.length)); }
/** True for any multi-user chat (group or channel). */
function isMultiKey(key) { return isGroupKey(key) || isChannelKey(key); }

function peerUsername(key) {
  return key === SAVED ? state.username : key;
}

function displayNameFor(username) {
  if (username === SAVED) return 'Saved Messages';
  if (isBotKey(username)) {
    const b = botFor(username);
    return b ? b.title : 'Бот';
  }
  if (isGroupKey(username)) {
    const g = state.groups.get(groupIdOf(username));
    return g ? g.name : 'Группа';
  }
  if (isChannelKey(username)) {
    const c = state.channels.get(channelIdOf(username));
    return c ? c.name : 'Канал';
  }
  const p = state.profiles.get(username);
  if (!p) return username;
  return p.displayName || username;
}

function avatarColorFor(username) {
  if (isBotKey(username)) { const b = botFor(username); return (b && b.color) || 'violet'; }
  if (isGroupKey(username)) return 'violet';
  if (isChannelKey(username)) return 'cyan';
  const p = state.profiles.get(username);
  return (p && p.avatarColor) || 'mint';
}

/** A verified account (the checkmark) as far as the client knows. */
function isVerified(username) {
  if (isBotKey(username)) return true;
  if (isGroupKey(username)) return false;
  if (isChannelKey(username)) {
    const c = state.channels.get(channelIdOf(username));
    return !!(c && c.verified);
  }
  const p = state.profiles.get(username);
  return !!(p && p.verified);
}

/** The admin-set badge picture for an account, or null for the plain checkmark. */
function badgeImageFor(username) {
  if (isGroupKey(username)) return null;
  if (isChannelKey(username)) {
    const c = state.channels.get(channelIdOf(username));
    return (c && c.badgeImage) || null;
  }
  const p = state.profiles.get(username);
  return (p && p.badgeImage) || null;
}

/** The profile picture for an account, or null to fall back to its initial. */
function avatarImageFor(username, profile) {
  if (isBotKey(username)) return null;
  if (isGroupKey(username)) return null;
  if (isChannelKey(username)) return null;
  const p = profile || state.profiles.get(username) || (username === state.username ? state.profile : null);
  return (p && p.avatarImage) || null;
}

/** Inner markup for an avatar: the picture when set, otherwise the initial. */
function avatarInnerHtml(username, profile) {
  const image = avatarImageFor(username, profile);
  if (image) return `<img class="avatar-img" src="${escapeHtml(image)}" alt="" />`;
  return escapeHtml(initial(displayNameFor(username)));
}

/**
 * Fill a badge element for the given account. A picture set by an admin is shown
 * as a round image; otherwise the element keeps the checkmark it ships with.
 * Callers show or hide the element themselves.
 */
function fillBadge(el, username) {
  if (!el) return;
  const image = badgeImageFor(username);
  const fallback = el.dataset.badgeFallback || el.innerHTML;
  el.dataset.badgeFallback = fallback;
  if (image) {
    el.classList.add('verified-badge-img');
    el.innerHTML = `<img src="${escapeHtml(image)}" alt="" />`;
  } else {
    el.classList.remove('verified-badge-img');
    el.innerHTML = fallback;
  }
}

/** Show or hide a badge for the given account, drawing its picture when set. */
function paintBadge(el, username) {
  if (!el) return;
  fillBadge(el, username);
  el.hidden = !isVerified(username);
}

function paintAvatar(el, username, size) {
  el.className = 'avatar' + (size ? ' ' + size : '');
  el.dataset.color = avatarColorFor(username);
  if (isBotKey(username)) {
    el.innerHTML = icon('i-robot');
    return;
  }
  if (isGroupKey(username)) {
    el.innerHTML = icon('i-people');
    return;
  }
  if (isChannelKey(username)) {
    el.innerHTML = icon('i-globe');
    return;
  }
  const image = avatarImageFor(username);
  if (image) {
    el.innerHTML = `<img class="avatar-img" src="${escapeHtml(image)}" alt="" />`;
    return;
  }
  el.textContent = initial(displayNameFor(username));
}

/* -------------------------------- auth UI -------------------------------- */
// Sign-in is a username and a password. The password protects the keys on this
// device and never leaves it. Phone sign-in is built but parked behind a
// disabled button until an SMS provider is paid for.
let authPhone = null;

function setMode(mode) {
  state.mode = mode;
  els.authTabs.dataset.active = mode;
  els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
  els.fieldConfirm.hidden = mode !== 'register';
  els.btnAuth.textContent = i18n.t(mode === 'register' ? 'Create account' : 'Sign in');
  els.authHint.textContent = mode === 'register'
    ? i18n.t('We generate your encryption keys on this device. Your password protects them — it never leaves your device.')
    : i18n.t('Your password protects your encryption keys on this device. We can never read your messages.');
  // The error is not cleared here: a failed sign-in runs setMode in its
  // `finally`, which would wipe the message before it could be read.
}

els.tabs.forEach((tab) => tab.addEventListener('click', () => {
  showError(els.authError, null);
  setMode(tab.dataset.tab);
}));

els.formAuth.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.authError, null);
  const username = bareUsername(els.authUser.value);
  const password = els.authPass.value;
  const confirm = els.authConfirm.value;

  if (!USERNAME_RE.test(username)) {
    return showError(els.authError, i18n.t('Username: 3–32 characters, a–z, 0–9 or _'));
  }
  if (password.length < 8) {
    return showError(els.authError, i18n.t('Password must be at least 8 characters'));
  }
  if (state.mode === 'register' && password !== confirm) {
    return showError(els.authError, i18n.t('Passwords do not match'));
  }

  els.btnAuth.disabled = true;
  els.btnAuth.textContent = i18n.t(state.mode === 'register' ? 'Creating…' : 'Signing in…');
  try {
    await api.connect(els.serverUrl.value.trim());
    if (state.mode === 'register') await api.register({ username, password });
    else await api.login({ username, password });
    els.authPass.value = '';
    els.authConfirm.value = '';
  } catch (err) {
    showError(els.authError, err.message || i18n.t('Something went wrong'));
  } finally {
    els.btnAuth.disabled = false;
    setMode(state.mode);
  }
});

/* ----------------------------- phone sign-in ----------------------------- */
// Reachable only when els.btnPhoneSignin is enabled, which it is not yet.
function showAuthStep(step) {
  const onCode = step === 'code';
  els.formPhone.hidden = onCode;
  els.formCode.hidden = !onCode;
  els.stepPhone.classList.toggle('active', !onCode);
  els.stepPhone.classList.toggle('done', onCode);
  els.stepCode.classList.toggle('active', onCode);
  showError(els.authPhoneError, null);
  showError(els.authCodeError, null);
  if (onCode) {
    els.authCode.value = '';
    els.authCode.focus();
  } else {
    els.authPhone.focus();
  }
}

els.btnPhoneSignin.addEventListener('click', () => {
  els.phoneFlow.hidden = false;
  els.formAuth.hidden = true;
  els.authTabs.hidden = true;
  showAuthStep('phone');
});

/** Back to the username-and-password form, which is the way in for now. */
function showAuthHome() {
  els.phoneFlow.hidden = true;
  els.formAuth.hidden = false;
  els.authTabs.hidden = false;
  els.authPhone.value = '';
  els.authCode.value = '';
  setMode('login');
}

els.formPhone.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.authPhoneError, null);
  const phone = els.authPhone.value.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s()-]/g, ''))) {
    return showError(els.authPhoneError, i18n.t('Enter a phone number in international format, e.g. +79991234567'));
  }

  els.btnPhone.disabled = true;
  els.btnPhone.textContent = i18n.t('Sending…');
  try {
    await api.connect(els.serverUrl.value.trim());
    const res = await api.requestCode(phone);
    authPhone = res.phone;
    els.authCodeHint.textContent = res.isNew
      ? i18n.t('A new account was created for this number.')
      : i18n.t('Welcome back. Enter the code to sign in.');
    // The relay can hand the code back while no SMS provider is configured.
    showAuthStep('code');
    if (res.code) els.authCode.value = res.code;
  } catch (err) {
    showError(els.authPhoneError, err.message || i18n.t('Something went wrong'));
  } finally {
    els.btnPhone.disabled = false;
    els.btnPhone.textContent = i18n.t('Send code');
  }
});

els.formCode.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.authCodeError, null);
  const code = els.authCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    return showError(els.authCodeError, i18n.t('Enter the 6-digit code'));
  }
  els.btnCode.disabled = true;
  els.btnCode.textContent = i18n.t('Checking…');
  try {
    await api.verifyCode({ phone: authPhone, code });
    els.authCode.value = '';
  } catch (err) {
    showError(els.authCodeError, err.message || i18n.t('Something went wrong'));
  } finally {
    els.btnCode.disabled = false;
    els.btnCode.textContent = i18n.t('Confirm');
  }
});

els.btnCodeBack.addEventListener('click', () => showAuthStep('phone'));

els.formUnlock.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.unlockError, null);
  try {
    await api.unlock(els.unlockPass.value);
    els.unlockPass.value = '';
  } catch (err) {
    showError(els.unlockError, err.message || 'Could not unlock');
  }
});

els.btnSwitch.addEventListener('click', async () => {
  await api.logout();
  resetToAuth();
});

function resetToAuth() {
  state.username = null;
  state.profile = null;
  state.profileTarget = null;
  state.unlocked = false;
  state.activePeer = null;
  state.chats.clear();
  state.profiles.clear();
  state.presence.clear();
  state.lastSeen.clear();
  state.drafts = {};
  state.folders = [];
  state.activeFolder = 'all';
  els.chatList.innerHTML = '';
  els.archivedList.innerHTML = '';
  els.chatBlank.hidden = false;
  els.chatView.hidden = true;
  renderChatList();
  showAuthHome();
  showScreen('auth');
}

/* -------------------------------- main UI -------------------------------- */
async function enterMain(username) {
  state.username = username;
  state.chats.clear();
  state.profiles.clear();
  state.presence.clear();
  state.lastSeen.clear();
  state.groups.clear();
  state.channels.clear();
  state.streak = null;
  els.meStreak.hidden = true;
  await refreshStatus();
  showScreen('main');
  await Promise.all([loadChats(), loadGroups(), loadChannels(), loadContacts(), loadStreak(), loadDrafts(), loadFolders()]);
  renderChatList();
}

async function loadChats() {
  try {
    const rows = await api.listChats();
    for (const row of rows) {
      const key = chatKey(row.peer);
      const chat = ensureChat(key);
      chat.pinned = row.pinned;
      chat.muted = row.muted;
      chat.archived = row.archived;
      chat.unread = row.unread;
      chat.lastTs = row.last ? row.last.ts : 0;
      chat.last = row.last
        ? (row.last.deleted ? 'Message deleted' : 'Encrypted message')
        : '';
      if (row.last && row.last.from && row.last.from !== state.username) chat.hasIncoming = true;
      // The chat row carries the peer's profile: seed it so the checkmark and
      // the badge/picture show right after a re-entry, not only once the
      // conversation is opened.
      if (row.peer && row.profile) {
        state.profiles.set(row.peer, row.profile);
        if (row.profile.lastSeen) state.lastSeen.set(row.peer, row.profile.lastSeen);
      }
    }
    renderChatList();
    // A profile arriving now may change the header of the chat already open.
    if (state.activePeer && !isGroupKey(state.activePeer)) {
      paintBadge(els.peerBadge, state.activePeer);
      paintAvatar(els.peerAvatar, state.activePeer);
    }
    updatePeerSub();
    refreshVisibleLastMessages();
  } catch { /* offline: keep whatever we have */ }
}

/** Turn the placeholder previews into readable text for chats we can decrypt. */
async function refreshVisibleLastMessages() {
  for (const [key, chat] of state.chats) {
    if (!chat.lastTs || chat.messages.length) continue;
    try {
      const items = isGroupKey(key)
        ? await api.groupHistory({ groupId: groupIdOf(key), limit: 1 })
        : isChannelKey(key)
          ? await api.channelHistory({ channelId: channelIdOf(key), limit: 1 })
          : await api.history({ with: peerUsername(key), limit: 1 });
      const last = items.at(-1);
      if (last) chat.last = previewOf(last);
    } catch { /* leave the placeholder */ }
  }
  renderChatList();
}

/** One-line preview for the chat list, matching the message kind. */
function previewOf(m) {
  if (m.deleted) return 'Message deleted';
  const gift = giftPayloadOf(m);
  if (gift) return `Подарок: ${gift.name || '🎁'}`;
  const poll = pollPayloadOf(m);
  if (poll) return `Опрос: ${poll.q}`;
  if (pollVoteOf(m)) return 'Голос в опросе';
  if (m.kind === 'image') return 'Photo';
  if (m.kind === 'voice') return 'Voice message';
  if (m.kind === 'file') return (m.attachment && m.attachment.name) || 'File';
  if (gamePayloadOf(m)) return 'Игра';
  return m.text || '';
}

/** Load every group the account belongs to and seed a chat row for each. */
async function loadGroups() {
  try {
    const groups = await api.listGroups();
    for (const g of groups) {
      state.groups.set(g.id, g);
      for (const m of g.members) {
        if (m.profile) state.profiles.set(m.username, m.profile);
        if (typeof m.online === 'boolean') state.presence.set(m.username, m.online);
      }
      ensureChat(groupKey(g.id));
    }
  } catch { /* offline: keep what we have */ }
}

async function loadContacts() {
  try {
    const s = await api.getSettings();
    if (s && Array.isArray(s.contacts)) state.contacts = s.contacts.slice();
  } catch { /* offline: keep what we have */ }
}

/** Persist the contact list into this account's server-side settings. */
async function saveContacts() {
  try { await api.saveSettings({ contacts: state.contacts }); } catch { /* best effort */ }
}

/**
 * Drafts: the text left in the composer per chat. They live in this account's
 * server-side settings, so a draft follows the account to another device, and
 * they are only ever sent to the relay as part of that settings document — the
 * relay never sees a draft as a message.
 */
async function loadDrafts() {
  try {
    const s = await api.getSettings();
    state.drafts = (s && s.drafts && typeof s.drafts === 'object' && !Array.isArray(s.drafts))
      ? { ...s.drafts } : {};
  } catch { /* offline: keep what we have */ }
}

function draftFor(key) {
  return state.drafts[key] || '';
}

function saveDraftsNow() {
  state.draftSaveTimer = null;
  api.saveSettings({ drafts: state.drafts }).catch(() => {});
}

/** Record a draft and schedule one coalesced settings write. */
function setDraft(key, text) {
  if (!key) return;
  const next = (text || '').trim() ? text : '';
  if (next) state.drafts[key] = next; else delete state.drafts[key];
  if (state.draftSaveTimer) clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = setTimeout(saveDraftsNow, 600);
}

/* ------------------------------- folders ------------------------------- */

/** Every folder the account has, with the built-in "all" tab in front. */
function folderList() {
  return [FOLDERS.allFolder(), ...state.folders];
}

/** One chat described the way the folder rules need it. */
function folderDesc(key) {
  const chat = state.chats.get(key);
  return {
    key,
    kind: FOLDERS.kindOf(key, isBotKey(key)),
    unread: chat ? (chat.unread || 0) : 0
  };
}

/** The active folder object, falling back to "all" if it was removed. */
function activeFolder() {
  const found = folderList().find((f) => f.id === state.activeFolder);
  if (found) return found;
  state.activeFolder = 'all';
  return folderList()[0];
}

/** Keys of the chats that belong in the active folder, archived excluded. */
function keysInActiveFolder(keys) {
  const folder = activeFolder();
  const descs = keys.filter((k) => !state.chats.get(k).archived).map(folderDesc);
  if (folder.id === 'all') {
    // A chat owned by an exclusive folder leaves the "all" list, like Telegram.
    const hidden = FOLDERS.exclusiveKeys(state.folders, descs);
    return descs.filter((d) => !hidden.has(d.key)).map((d) => d.key);
  }
  return FOLDERS.filter(folder, descs).map((d) => d.key);
}

async function loadFolders() {
  try {
    const s = await api.getSettings();
    state.folders = FOLDERS.normalizeAll(s && s.folders);
  } catch { /* offline: keep what we have */ }
}

/** Persist the folder list into this account's server-side settings. */
function saveFolders() {
  api.saveSettings({ folders: state.folders }).catch(() => {});
  renderFolderTabs();
  renderChatList();
}

/** The row of folder tabs above the chat list. */
function renderFolderTabs() {
  if (!els.folderTabs) return;
  const folders = folderList();
  els.folderTabs.hidden = folders.length < 2;
  els.folderTabs.innerHTML = '';
  for (const folder of folders) {
    const descs = Array.from(state.chats.keys())
      .filter((k) => !state.chats.get(k).archived)
      .map(folderDesc);
    const unread = FOLDERS.unreadIn(folder, descs);
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'folder-tab' + (folder.id === state.activeFolder ? ' active' : '');
    tab.dataset.folder = folder.id;
    tab.innerHTML = `<span class="folder-tab-name">${escapeHtml(folder.name)}</span>`
      + (unread ? `<span class="folder-tab-badge">${unread > 99 ? '99+' : unread}</span>` : '');
    tab.addEventListener('click', () => {
      state.activeFolder = folder.id;
      renderFolderTabs();
      renderChatList();
    });
    // Right-click a custom tab to edit it, the way Telegram does.
    if (!folder.system) {
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openFolderEditor(folder.id);
      });
    }
    els.folderTabs.appendChild(tab);
  }
}

/** Load every channel the account subscribes to and seed a chat row for each. */
async function loadChannels() {
  try {
    const channels = await api.listChannels();
    for (const c of channels) {
      state.channels.set(c.id, c);
      if (c.ownerProfile) state.profiles.set(c.owner, c.ownerProfile);
      ensureChat(channelKey(c.id));
    }
  } catch { /* offline: keep what we have */ }
}

function ensureChat(key) {
  if (!state.chats.has(key)) {
    state.chats.set(key, {
      key, pinned: false, muted: false, archived: false, unread: 0,
      last: '', lastTs: 0, messages: [], loaded: false
    });
  }
  return state.chats.get(key);
}

function sortedKeys(list) {
  return list.sort((a, b) => {
    const ca = state.chats.get(a);
    const cb = state.chats.get(b);
    if (ca.pinned !== cb.pinned) return ca.pinned ? -1 : 1;
    return (cb.lastTs || 0) - (ca.lastTs || 0);
  });
}

/** Everything a chat row shows, as one string, so an unchanged row is skipped. */
function chatRowSignature(chat) {
  const key = chat.key;
  const peer = peerUsername(key);
  const tick = isVerified(peer) ? (badgeImageFor(peer) || 'check') : '';
  return [displayNameFor(key), tick, avatarImageFor(key) || '', chat.lastTs || 0,
    chat.last || '', chat.unread || 0, chat.muted ? 1 : 0, chat.pinned ? 1 : 0,
    state.drafts[key] || ''].join('\u0000');
}

function chatItemEl(key) {
  const chat = state.chats.get(key);
  const peer = peerUsername(key);
  const group = isGroupKey(key);
  const channel = isChannelKey(key);
  const li = document.createElement('li');
  li.className = 'chat-item' + (key === state.activePeer ? ' active' : '');
  li.dataset.peer = key;
  const badge = chat.unread
    ? `<span class="chat-item-badge${chat.muted ? ' muted' : ''}">${chat.unread > 99 ? '99+' : chat.unread}</span>`
    : '';
  const flags = [
    chat.pinned ? icon('i-pin', 'chat-flag') : '',
    chat.muted ? icon('i-bell-off', 'chat-flag') : ''
  ].filter(Boolean).join(' ');

  const name = key === SAVED ? 'Saved Messages' : displayNameFor(key);
  const avatarInner = group ? icon('i-people') : (channel ? icon('i-globe') : avatarInnerHtml(key));
  const tickImage = !group ? badgeImageFor(peer) : null;
  const tick = !group && isVerified(peer)
    ? (tickImage
      ? `<span class="verified-badge verified-badge-sm verified-badge-img" title="Проверенный аккаунт"><img src="${escapeHtml(tickImage)}" alt="" /></span>`
      : `<span class="verified-badge verified-badge-sm" title="Проверенный аккаунт">${icon('i-check')}</span>`)
    : '';
  chat.tick = tick;
  chat.tickImage = tickImage;

  // A draft replaces the last-message preview, the way Telegram shows it.
  const draft = state.drafts[key];
  const lastLine = draft
    ? `<span class="draft-tag">Черновик:</span> ${escapeHtml(draft)}`
    : escapeHtml(chat.last || 'No messages yet');
  const lastCls = 'chat-item-last' + (draft ? ' draft' : '');

  li.innerHTML = `
    <div class="avatar small" data-color="${escapeHtml(avatarColorFor(key))}">${avatarInner}</div>
    <div class="chat-item-body">
      <div class="chat-item-top">
        <span class="chat-item-name"><span class="chat-item-name-text">${escapeHtml(name)}</span>${tick}</span>
        <span class="chat-item-time">${chat.lastTs ? escapeHtml(timeLabel(chat.lastTs)) : ''}</span>
      </div>
      <div class="${lastCls}">${lastLine}</div>
    </div>
    <div class="chat-item-flags">${flags}${badge}</div>
  `;
  li.addEventListener('click', () => openChat(key));
  li.dataset.sig = chatRowSignature(chat);
  return li;
}

/**
 * Repaint the chat list. Rows whose content has not changed keep their DOM node,
 * so the list does not flicker and the browser does no work for untouched rows.
 * Only reordering (a new last message) moves an existing node.
 */
function renderChatListNow() {
  const keys = Array.from(state.chats.keys());
  const active = sortedKeys(keysInActiveFolder(keys));
  const archived = sortedKeys(keys.filter((k) => state.chats.get(k).archived));

  paintChatSection(els.chatList, active);
  paintChatSection(els.archivedList, archived);
  els.sectionArchived.hidden = archived.length === 0;
  els.archivedCount.textContent = String(archived.length);

  if (els.drawerArchivedCount) {
    els.drawerArchivedCount.hidden = archived.length === 0;
    els.drawerArchivedCount.textContent = String(archived.length);
  }

  renderFolderTabs();

  const total = active.length + archived.length;
  els.chatEmpty.hidden = total > 0;
}

let chatListScheduled = false;
function renderChatList() {
  if (chatListScheduled) return;
  chatListScheduled = true;
  requestAnimationFrame(() => { chatListScheduled = false; renderChatListNow(); });
}

function paintChatSection(container, keys) {
  const existing = new Map();
  for (const el of Array.from(container.children)) {
    if (el.classList.contains('chat-item')) existing.set(el.dataset.peer, el);
    else el.remove();
  }
  const seen = new Set();
  let cursor = container.firstElementChild;
  for (const key of keys) {
    seen.add(key);
    const chat = state.chats.get(key);
    let el = existing.get(key);
    // Note whether this node is the one the cursor expects *before* a possible
    // replacement, because `replaceWith` detaches the old node and a detached
    // node can no longer be used as an insertion reference.
    const atCursor = !!el && el === cursor;
    if (!el) {
      el = chatItemEl(key);
    } else if (el.dataset.sig !== chatRowSignature(chat)) {
      const next = chatItemEl(key);
      el.replaceWith(next);
      el = next;
    }
    el.classList.toggle('active', key === state.activePeer);
    // Walk the cursor to the row that must sit here, inserting only when the
    // order actually changed.
    if (atCursor) {
      cursor = el.nextElementSibling;
    } else {
      container.insertBefore(el, cursor);
    }
  }
  for (const el of Array.from(container.children)) {
    if (!seen.has(el.dataset.peer)) el.remove();
  }
}

function renderMessageBody(m) {
  if (m.deleted) return '<span class="deleted-text">This message was deleted</span>';
  const poll = pollPayloadOf(m);
  if (poll) return '<div class="poll-mount"></div>';
  const gift = giftPayloadOf(m);
  if (gift) {
    return `<div class="gift-bubble"><span class="gift-bubble-emoji">${escapeHtml(gift.emoji || '🎁')}</span>
      <span class="gift-bubble-name">${escapeHtml(gift.name || 'Подарок')}</span>
      <span class="gift-bubble-cost">${Number(gift.cost) || 0} ⭐</span></div>`;
  }
  if (m.kind && m.attachment) {
    const cap = m.text ? `<div class="caption">${messageTextHtml(m.text)}</div>` : '';
    return `<div class="att-wrap" data-kind="${escapeHtml(m.kind)}"></div>${cap}`;
  }
  return messageTextHtml(m.text);
}

function reactionsHtml(m) {
  if (!m.reactions || !m.reactions.length) return '';
  const grouped = new Map();
  for (const r of m.reactions) {
    grouped.set(r.emoji, (grouped.get(r.emoji) || 0) + 1);
  }
  const chips = Array.from(grouped.entries()).map(([emoji, count]) => {
    const mine = m.reactions.some((r) => r.emoji === emoji && r.username === state.username);
    return `<button class="reaction-chip${mine ? ' mine' : ''}" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}${count > 1 ? ' ' + count : ''}</button>`;
  }).join('');
  return `<div class="reactions">${chips}</div>`;
}

function quoteHtml(m) {
  if (!m.replyTo || !m.quote) return '';
  return `
    <div class="quote">
      <span class="quote-who">${escapeHtml(m.quote.mine ? 'You' : displayNameFor(m.quote.from))}</span>
      <span class="quote-text">${escapeHtml(m.quote.text || 'Message deleted')}</span>
    </div>`;
}

function messageEl(m) {
  // The live game board is a pseudo-message pinned under the transcript.
  if (m && m.__gameBoard) {
    const box = document.createElement('div');
    box.className = 'msg game-msg';
    box.dataset.id = 'game-board';
    box.appendChild(renderGameBoard(m.__gameBoard));
    return box;
  }
  const el = document.createElement('div');
  const hit = state.searchQuery && state.searchHits.includes(m.id);
  const current = hit && state.searchHits[state.searchIndex] === m.id;
  el.className = 'msg ' + (m.mine ? 'out' : 'in')
    + (m.deleted ? ' deleted' : '')
    + (m.pending ? ' pending' : '')
    + (m.failed ? ' failed' : '')
    + (m.kind && m.attachment ? ' has-attachment' : '')
    + (hit ? ' search-hit' : '')
    + (current ? ' search-current' : '');
  el.dataset.id = m.id;
  const meta = [escapeHtml(timeLabel(m.ts))];
  if (m.editedAt) meta.push('<span class="edited">edited</span>');
  if (m.pinned) meta.push(`<span class="pinned-mark" title="Pinned">${icon('i-pin')}</span>`);
  const hasMedia = !!(m.kind && m.attachment);
  el.innerHTML = `
    <div class="bubble${hasMedia ? ' has-media' : ''}">${quoteHtml(m)}${renderMessageBody(m)}</div>
    ${reactionsHtml(m)}
    <div class="meta">${meta.join('')}</div>
  `;

  if (hasMedia) {
    const wrap = el.querySelector('.att-wrap');
    if (m.kind === 'image') renderImageAttachment(m, wrap);
    else renderFileAttachment(m, wrap, m.kind);
  }

  const pollMount = el.querySelector('.poll-mount');
  if (pollMount) pollMount.replaceWith(pollElement(m));

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (m.pending || m.deleted) return;
    if (state.selecting) { toggleSelected(m.id); return; }
    openContextMenu(m, e.clientX, e.clientY);
  });
  if (state.selecting) {
    el.classList.add('selectable');
    if (state.selecting.has(m.id)) el.classList.add('selected');
    const tick = document.createElement('span');
    tick.className = 'select-tick';
    tick.innerHTML = state.selecting.has(m.id) ? icon('i-check') : '';
    el.appendChild(tick);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelected(m.id);
    });
  }
  el.querySelectorAll('.reaction-chip').forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleReaction(m.id, chip.dataset.emoji);
    });
  });
  el.querySelectorAll('.mention').forEach((span) => {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = span.dataset.username;
      if (name && name !== state.username) openProfile(name);
    });
  });
  return el;
}

function appendMessage(m) {
  els.messages.appendChild(messageEl(m));
  els.messages.scrollTop = els.messages.scrollHeight;
}

function scrollToMessage(id, { smooth = true } = {}) {
  const el = els.messages.querySelector(`.msg[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 900);
}

function findMessage(id) {
  for (const chat of state.chats.values()) {
    const m = chat.messages.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

/**
 * Attach the quoted text to any message that references another one. Live
 * messages resolve their quote as they arrive; messages loaded from history
 * need this pass once the whole page is in memory.
 */
function resolveQuotes(items) {
  const byId = new Map(items.map((m) => [m.id, m]));
  for (const m of items) {
    if (m.replyTo && !m.quote) {
      const orig = byId.get(m.replyTo);
      if (orig) m.quote = { from: orig.from, text: orig.deleted ? 'Message deleted' : orig.text, mine: orig.mine };
    }
  }
  return items;
}

function activeChat() {
  return state.activePeer ? state.chats.get(state.activePeer) : null;
}

/* --------------------------------- chat --------------------------------- */
async function openChat(key) {
  state.activePeer = key;
  const chat = ensureChat(key);
  chat.unread = 0;
  const group = isGroupKey(key);
  const channel = isChannelKey(key);

  els.chatBlank.hidden = true;
  els.chatView.hidden = false;
  els.messages.innerHTML = '';
  clearReply();
  clearEditing();
  closeChatSearch();
  if (state.selecting) exitSelectMode();

  els.peerName.textContent = displayNameFor(key);
  paintBadge(els.peerBadge, key);
  paintAvatar(els.peerAvatar, key);
  updatePeerSub();
  updateComposerForChannel(key);
  // Restore the draft left in this chat, unless the composer is read-only.
  els.composerInput.value = els.composerInput.disabled ? '' : draftFor(key);
  renderChatList();

  if (isBotKey(key)) {
    // A bot chat has no server history; its transcript is local. Open it as-is.
    renderMessages();
    els.composerInput.focus();
    return;
  }

  if (!chat.loaded) {
    try {
      const items = group
        ? await api.groupHistory({ groupId: groupIdOf(key), limit: 200 })
        : channel
          ? await api.channelHistory({ channelId: channelIdOf(key), limit: 200 })
          : await api.history({ with: peerUsername(key), limit: 200 });
      chat.messages = resolveQuotes(items);
      chat.loaded = true;
      renderMessages();
      const last = items.at(-1);
      if (last) { chat.last = previewOf(last); chat.lastTs = last.ts; }
    } catch (err) {
      appendMessage({ text: (err.message || 'Could not load history'), ts: Date.now(), mine: false });
    }
  } else {
    renderMessages();
  }
  if (!isMultiKey(key)) { try { await api.markRead(peerUsername(key)); } catch { /* best effort */ } }
  updatePinnedBar();
  renderChatList();
  els.composerInput.focus();
}

/** In a channel only the owner may post; everyone else gets a read-only bar. */
function updateComposerForChannel(key) {
  const channel = isChannelKey(key) ? state.channels.get(channelIdOf(key)) : null;
  const readOnly = !!(channel && !channel.isOwner);
  els.composer.classList.toggle('readonly', readOnly);
  els.composerInput.disabled = readOnly;
  els.composerInput.placeholder = readOnly ? 'Только владелец может публиковать' : 'Message';
  if (readOnly) els.composerInput.value = '';
}

function appendMessage(m) {
  els.messages.appendChild(messageEl(m));
  els.messages.scrollTop = els.messages.scrollHeight;
}

/**
 * Repaint the message list. The whole list is rebuilt because a message change
 * can shift day separators and edit markers; a coalescing scheduler
 * (`renderMessages`) bounds the cost, so a burst of events paints once.
 */
function renderMessagesNow() {
  const chat = activeChat();
  if (!chat) return;
  const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 60;
  els.messages.innerHTML = '';
  const frag = document.createDocumentFragment();
  let lastDay = null;
  for (const m of chat.messages) {
    // Game positions are hidden from the transcript: the live board below shows
    // the position they carry, so a bubble per move would only be noise. A poll
    // vote is likewise hidden: it only moves the tally shown on the poll card.
    if (gamePayloadOf(m) || pollVoteOf(m)) continue;
    const day = dayLabel(m.ts);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      frag.appendChild(sep);
      lastDay = day;
    }
    frag.appendChild(messageEl(m));
  }
  els.messages.appendChild(frag);
  renderGameBoardInto(chat);
  if (atBottom || state.forceScrollBottom) els.messages.scrollTop = els.messages.scrollHeight;
  state.forceScrollBottom = false;
}

/**
 * The live game board is drawn once, pinned under the transcript, rather than
 * once per move message. A game is one evolving object; a board per message
 * would both flood the chat and show a stale position in every older bubble.
 */
function renderGameBoardInto(chat) {
  if (!chat || !chat.game || !GAMES) return;
  els.messages.appendChild(messageEl({ __gameBoard: chat.game }));
}

/* A burst of events (a fan-out, a history load, a reaction) must not repaint the
   list once per event: coalesce them into one frame. A single live message uses
   the O(1) append path instead. Callers that need the new DOM immediately
   (scrolling to a search hit) use `renderMessagesImmediate`. */
let messagesScheduled = false;
function renderMessages() {
  if (messagesScheduled) return;
  messagesScheduled = true;
  requestAnimationFrame(() => { messagesScheduled = false; renderMessagesNow(); });
}

function renderMessagesImmediate() {
  messagesScheduled = false;
  renderMessagesNow();
}

/**
 * Append one message at the end of the open chat without rebuilding the list.
 * A live message only ever lands at the end, so this keeps a long conversation
 * O(1) per message instead of O(n). Returns false when a full rebuild is needed
 * (a search is filtering, select mode is on, or the message is not the last one).
 */
function appendMessageEl(m) {
  if (state.searchQuery || state.selecting || !state.activePeer) return false;
  const chat = activeChat();
  if (!chat || chat.messages[chat.messages.length - 1] !== m) return false;
  const prev = chat.messages[chat.messages.length - 2];
  if (!prev || dayLabel(prev.ts) !== dayLabel(m.ts)) {
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = dayLabel(m.ts);
    els.messages.appendChild(sep);
  }
  const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 60;
  els.messages.appendChild(messageEl(m));
  // The live board is pinned to the very end, so a message that arrives while a
  // game is open must land above it, not below.
  const board = els.messages.querySelector('.game-msg');
  if (board && board !== els.messages.lastElementChild) els.messages.appendChild(board);
  if (atBottom || state.forceScrollBottom) els.messages.scrollTop = els.messages.scrollHeight;
  state.forceScrollBottom = false;
  return true;
}

function updatePeerSub() {
  const key = state.activePeer;
  if (!key) return;
  if (key === SAVED) {
    els.peerSub.textContent = 'Notes and files only you can read';
    els.peerSub.classList.remove('typing');
    return;
  }
  if (isBotKey(key)) {
    const b = botFor(key);
    els.peerSub.classList.remove('typing');
    els.peerSub.textContent = (b && b.subtitle) || 'bot';
    return;
  }
  if (isGroupKey(key)) {
    const g = state.groups.get(groupIdOf(key));
    const members = (g && g.members) || [];
    const n = members.length;
    const online = members.filter((m) => m.username !== state.username && state.presence.get(m.username)).length;
    els.peerSub.classList.remove('typing');
    const head = `${n} ${plural(n, 'участник', 'участника', 'участников')}`;
    els.peerSub.textContent = online > 0 ? `${head}, ${online} в сети` : head;
    return;
  }
  if (isChannelKey(key)) {
    const c = state.channels.get(channelIdOf(key));
    const n = (c && c.subs) || 0;
    els.peerSub.classList.remove('typing');
    const head = `${n} ${plural(n, 'подписчик', 'подписчика', 'подписчиков')}`;
    els.peerSub.textContent = (c && c.handle) ? `@${c.handle} · ${head}` : head;
    return;
  }
  const peer = peerUsername(key);
  const timer = state.typing.get(peer);
  if (timer) {
    els.peerSub.textContent = 'typing…';
    els.peerSub.classList.add('typing');
    return;
  }
  els.peerSub.classList.remove('typing');
  const presence = peerPresenceText(peer);
  els.peerSub.textContent = (presence || 'end-to-end encrypted') + streakSuffix(peer);
}

/** " · 5 🔥" when a peer has a streak, so the header shows it at a glance. */
function streakSuffix(username) {
  const p = state.profiles.get(username);
  return p && p.streak > 0 ? ` · ${p.streak} 🔥` : '';
}

/* ------------------------------- searching ------------------------------- */
let searchTimer = null;
els.search.addEventListener('input', () => {
  const q = els.search.value.trim();
  els.btnSearchClear.hidden = q.length === 0;
  clearTimeout(searchTimer);
  if (!q) return closeSearchPanel();
  searchTimer = setTimeout(() => runSearch(q), 180);
});

els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { els.search.value = ''; els.btnSearchClear.hidden = true; closeSearchPanel(); }
  if (e.key === 'Enter') {
    const q = bareUsername(els.search.value);
    if (USERNAME_RE.test(q)) {
      els.search.value = '';
      els.btnSearchClear.hidden = true;
      closeSearchPanel();
      startChatWith(q);
    }
  }
});

els.btnSearchClear.addEventListener('click', () => {
  els.search.value = '';
  els.btnSearchClear.hidden = true;
  closeSearchPanel();
});

function closeSearchPanel() {
  els.searchPanel.hidden = true;
  els.chatSections.hidden = false;
}

async function runSearch(query) {
  let items = [];
  try { items = await api.searchUsers(query); } catch { items = []; }
  for (const u of items) {
    state.profiles.set(u.username, u);
    state.presence.set(u.username, !!u.online);
  }
  // An `@handle` may name a channel rather than a person. Try that too, so the
  // same box finds both, and show a channel row above the people.
  let channelHit = null;
  const handle = bareUsername(query);
  if (handle && USERNAME_RE.test(handle)) {
    try { channelHit = await api.channelInfo({ handle }); } catch { channelHit = null; }
    if (channelHit) state.channels.set(channelHit.id, channelHit);
  }
  els.searchPanel.hidden = false;
  els.chatSections.hidden = true;
  els.searchResults.innerHTML = '';
  els.searchEmpty.hidden = items.length > 0 || !!channelHit;

  if (channelHit) {
    const li = document.createElement('li');
    li.className = 'chat-item';
    const label = channelHit.subscribed ? (channelHit.isOwner ? 'ваш канал' : 'вы подписаны') : 'канал';
    li.innerHTML = `
      <div class="avatar small" data-color="cyan">${icon('i-globe')}</div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(channelHit.name)}</span>
        </div>
        <div class="chat-item-last">@${escapeHtml(channelHit.handle)} · ${label}</div>
      </div>
    `;
    li.addEventListener('click', () => {
      els.search.value = '';
      els.btnSearchClear.hidden = true;
      closeSearchPanel();
      if (channelHit.subscribed) {
        ensureChat(channelKey(channelHit.id));
        renderChatList();
        openChat(channelKey(channelHit.id));
      } else {
        subscribeToChannel(channelHit.id);
      }
    });
    els.searchResults.appendChild(li);
  }

  for (const u of items) {
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.dataset.username = u.username;
    li.innerHTML = `
      <div class="avatar small" data-color="${escapeHtml(u.avatarColor || 'mint')}">${avatarInnerHtml(u.username, u)}</div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(u.displayName || u.username)}</span>
        </div>
        <div class="chat-item-last">@${escapeHtml(u.username)}${u.online ? ' · online' : ''}</div>
      </div>
    `;
    li.addEventListener('click', () => {
      els.search.value = '';
      els.btnSearchClear.hidden = true;
      closeSearchPanel();
      startChatWith(u.username);
    });
    els.searchResults.appendChild(li);
  }
}

function startChatWith(username) {
  const key = chatKey(username);
  ensureChat(key);
  renderChatList();
  openChat(key);
}

/* ------------------------------ sending ------------------------------ */
/** Members of a group, used to encrypt one copy per recipient. */
function groupMemberNames(groupId) {
  const g = state.groups.get(groupId);
  return g ? g.members.map((m) => m.username) : [];
}

/** Subscriber usernames for a channel the signed-in account owns. */
function channelSubNames(channelId) {
  const c = state.channels.get(channelId);
  if (!c) return [];
  if (Array.isArray(c.subscribers) && c.subscribers.length) return c.subscribers.slice();
  // Fall back to at least the owner so a post is never addressed to nobody.
  return state.username ? [state.username] : [];
}

async function sendCurrentMessage(text) {
  const key = state.activePeer;
  const chat = ensureChat(key);

  // A bot chat is local: echo the message and answer on this device. Nothing
  // leaves the machine, so the relay never sees a bot conversation.
  if (isBotKey(key)) {
    const ts = Date.now();
    chat.messages.push({ id: 'bot-me-' + ts, text, ts, mine: true, reactions: [] });
    chat.last = text;
    chat.lastTs = ts;
    state.forceScrollBottom = true;
    renderMessages();
    renderChatList();
    noteLocalSend();
    botReply(key, text, chat);
    return;
  }

  const replyTo = state.replyTo;

  const optimistic = {
    id: 'tmp-' + Date.now(), text, ts: Date.now(), mine: true,
    replyTo: replyTo ? replyTo.id : null,
    quote: replyTo ? { from: replyTo.from, text: replyTo.text, mine: replyTo.mine } : null,
    pending: true, reactions: []
  };
  chat.messages.push(optimistic);
  chat.last = text;
  chat.lastTs = optimistic.ts;
  clearReply();
  state.forceScrollBottom = true;
  renderMessages();
  renderChatList();

  try {
    if (isGroupKey(key)) {
      const groupId = groupIdOf(key);
      const res = await api.sendGroup({
        groupId, text, members: groupMemberNames(groupId),
        replyTo: replyTo ? replyTo.id : undefined
      });
      optimistic.id = res.id;
    } else if (isChannelKey(key)) {
      const channelId = channelIdOf(key);
      const res = await api.sendChannelPost({
        channelId, text, members: channelSubNames(channelId),
        replyTo: replyTo ? replyTo.id : undefined
      });
      optimistic.id = res.id;
    } else {
      const res = await api.send({ to: peerUsername(key), text, replyTo: replyTo ? replyTo.id : undefined });
      optimistic.id = res.id;
    }
    noteLocalSend();
    optimistic.pending = false;
    const el = els.messages.querySelector(`.msg[data-id="${optimistic.id}"]`);
    if (el) el.classList.remove('pending');
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    renderMessages();
    toast(err.message || 'Message not sent');
  }
}

els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.composerInput.value.trim();
  if (!text || !state.activePeer) return;

  if (state.editing) {
    const target = state.editing;
    els.composerInput.value = '';
    clearEditing();
    const chat = activeChat();
    const m = chat.messages.find((x) => x.id === target.id);
    if (m) {
      try {
        const res = isGroupKey(state.activePeer)
          ? await api.editGroupMessage({
              id: target.id, groupId: groupIdOf(state.activePeer), text,
              members: groupMemberNames(groupIdOf(state.activePeer))
            })
          : isChannelKey(state.activePeer)
            ? await api.editChannelMessage({
                id: target.id, channelId: channelIdOf(state.activePeer), text,
                members: channelSubNames(channelIdOf(state.activePeer))
              })
            : await api.edit({ id: target.id, to: peerUsername(state.activePeer), text });
        m.text = text;
        m.editedAt = res.editedAt;
      } catch (err) {
        m.text = target.original;
        toast(err.message || 'Could not edit');
      }
      renderMessages();
      renderChatList();
    }
    return;
  }

  els.composerInput.value = '';
  setDraft(state.activePeer, '');
  renderChatList();
  await sendCurrentMessage(text);
});

/* typing indicator (throttled) + draft persistence */
let typingSentAt = 0;
els.composerInput.addEventListener('input', () => {
  if (!state.activePeer) return;
  // The composer text is this chat's draft: it survives switching away and
  // follows the account to another device.
  if (!els.composerInput.disabled) {
    setDraft(state.activePeer, els.composerInput.value);
    renderChatList();
  }
  if (state.activePeer === SAVED || isMultiKey(state.activePeer)) return;
  const now = Date.now();
  if (now - typingSentAt < 2500) return;
  typingSentAt = now;
  api.typing({ to: peerUsername(state.activePeer), state: 'start' }).catch(() => {});
});

/* ------------------------------ reply / edit ------------------------------ */
function setReply(m) {
  state.replyTo = {
    id: m.id, text: m.deleted ? 'Message deleted' : m.text, from: m.mine ? state.username : peerUsername(state.activePeer), mine: m.mine
  };
  els.replyBarTitle.textContent = m.mine ? 'Reply to yourself' : `Reply to ${displayNameFor(peerUsername(state.activePeer))}`;
  els.replyBarText.textContent = state.replyTo.text;
  els.replyBar.hidden = false;
  clearEditing();
  els.composerInput.focus();
}

function clearReply() {
  state.replyTo = null;
  els.replyBar.hidden = true;
}

function setEditing(m) {
  state.editing = { id: m.id, original: m.text };
  els.editBarText.textContent = m.text;
  els.editBar.hidden = false;
  els.composerInput.value = m.text;
  clearReply();
  els.composerInput.focus();
}

function clearEditing() {
  state.editing = null;
  els.editBar.hidden = true;
}

els.btnReplyCancel.addEventListener('click', clearReply);
els.btnEditCancel.addEventListener('click', () => { clearEditing(); els.composerInput.value = ''; });

/* ---------------------------- context menu ---------------------------- */
function openContextMenu(m, x, y) {
  const inGroup = isGroupKey(state.activePeer);
  const inChannel = isChannelKey(state.activePeer);
  state.ctxTarget = { id: m.id, mine: m.mine, text: m.text, pinned: !!m.pinned, group: inGroup, channel: inChannel };
  els.ctxEdit.hidden = !m.mine || !!m.kind;
  els.ctxDelete.hidden = !m.mine;
  // Pins and reactions are per-conversation on the relay; groups and channels
  // do not carry them yet, so the menu hides those entries there.
  els.ctxPin.hidden = inGroup || inChannel;
  els.ctxPinLabel.textContent = m.pinned ? 'Unpin' : 'Pin';
  els.ctxReactions.innerHTML = '';
  if (!inGroup && !inChannel) {
    for (const emoji of QUICK_REACTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-reaction';
      b.textContent = emoji;
      b.addEventListener('click', async () => {
        closeContextMenu();
        await toggleReaction(m.id, emoji);
      });
      els.ctxReactions.appendChild(b);
    }
  }
  els.ctxBackdrop.hidden = false;
  const menu = els.ctxMenu;
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 10;
  const maxY = window.innerHeight - rect.height - 10;
  menu.style.left = Math.max(10, Math.min(x, maxX)) + 'px';
  menu.style.top = Math.max(10, Math.min(y, maxY)) + 'px';
}

function closeContextMenu() {
  els.ctxBackdrop.hidden = true;
  state.ctxTarget = null;
}

els.ctxBackdrop.addEventListener('click', (e) => {
  if (e.target === els.ctxBackdrop) closeContextMenu();
});

els.ctxMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('.menu-item');
  if (!btn || !state.ctxTarget) return;
  const { id, mine, text } = state.ctxTarget;
  const action = btn.dataset.action;
  closeContextMenu();

  if (action === 'copy') {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Could not copy'); }
    return;
  }
  if (action === 'reply') {
    const m = findMessage(id);
    if (m) setReply(m);
    return;
  }
  if (action === 'edit') {
    const m = findMessage(id);
    if (m) setEditing(m);
    return;
  }
  if (action === 'pin') {
    const m = findMessage(id);
    if (!m || isGroupKey(state.activePeer)) return;
    try {
      const res = await api.pinMessage({ id, pinned: !m.pinned });
      m.pinned = res.pinned;
      updatePinnedBar();
      renderMessages();
      toast(res.pinned ? 'Pinned' : 'Unpinned');
    } catch (err) {
      toast(err.message || 'Could not pin');
    }
    return;
  }
  if (action === 'forward') {
    const m = findMessage(id);
    if (m) openForward(m);
    return;
  }
  if (action === 'select') {
    const m = findMessage(id);
    if (m) enterSelectMode(m);
    return;
  }
  if (action === 'delete') {
    const ok = await confirmDialog({
      title: 'Delete message?',
      text: 'This message will be removed for both you and the recipient.',
      confirmLabel: 'Delete'
    });
    if (!ok) return;
    try {
      if (isGroupKey(state.activePeer)) await api.deleteGroupMessage({ id });
      else if (isChannelKey(state.activePeer)) await api.deleteChannelMessage({ id });
      else await api.remove(id);
      applyDeleted(id);
      toast('Message deleted');
    } catch (err) {
      toast(err.message || 'Could not delete');
    }
  }
});

/* ---------------------------- reactions ---------------------------- */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '😢'];

async function toggleReaction(id, emoji) {
  const m = findMessage(id);
  if (!m) return;
  const mine = (m.reactions || []).find((r) => r.username === state.username);
  const next = mine && mine.emoji === emoji ? '' : emoji;
  try {
    const res = await api.react({ id, emoji: next });
    applyReactions(id, res.reactions);
  } catch (err) {
    toast(err.message || 'Could not react');
  }
}

function applyReactions(id, reactions) {
  const m = findMessage(id);
  if (!m) return;
  m.reactions = reactions;
  if (state.activePeer) renderMessages();
}

function applyDeleted(id) {
  const m = findMessage(id);
  if (!m) return;
  m.deleted = true;
  m.text = '';
  m.reactions = [];
  if (state.activePeer) renderMessages();
}

function applyEdited(id, text, editedAt) {
  const m = findMessage(id);
  if (!m) return;
  m.text = text;
  m.editedAt = editedAt;
  if (state.activePeer) renderMessages();
}

/* ------------------------------ chat menu ------------------------------ */
function openChatMenu() {
  const chat = activeChat();
  if (!chat) return;
  const isSaved = state.activePeer === SAVED;
  const channel = isChannelKey(state.activePeer) ? state.channels.get(channelIdOf(state.activePeer)) : null;
  els.chatmenuTitle.textContent = isSaved ? 'Saved Messages' : displayNameFor(state.activePeer);
  els.menuPinLabel.textContent = chat.pinned ? 'Unpin' : 'Pin';
  els.menuMuteLabel.textContent = chat.muted ? 'Unmute' : 'Mute';
  els.menuArchiveLabel.textContent = chat.archived ? 'Unarchive' : 'Archive';
  els.chatmenuBody.querySelectorAll('[data-action="delete"]').forEach((b) => { b.hidden = isSaved; });
  // Leaving applies to channels only, and never to the channel's own owner.
  els.menuLeave.hidden = !channel || channel.isOwner;
  els.menuLeaveLabel.textContent = 'Покинуть канал';
  // Channel settings are for the owner; the shareable @handle is for everyone.
  els.menuChannelSettings.hidden = !channel || !channel.isOwner;
  els.menuChannelLink.hidden = !channel || !channel.handle;
  els.chatmenuBackdrop.hidden = false;
}

els.btnChatMenu.addEventListener('click', openChatMenu);
els.btnChatmenuClose.addEventListener('click', () => { els.chatmenuBackdrop.hidden = true; });
els.chatmenuBackdrop.addEventListener('click', (e) => {
  if (e.target === els.chatmenuBackdrop) els.chatmenuBackdrop.hidden = true;
});

els.chatmenuBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.menu-item');
  if (!btn) return;
  const action = btn.dataset.action;
  const key = state.activePeer;
  const chat = activeChat();
  if (!key || !chat) return;
  const peer = peerUsername(key);
  els.chatmenuBackdrop.hidden = true;

  try {
    if (action === 'pin') {
      const res = await api.chatSettings({ peer, pinned: !chat.pinned });
      chat.pinned = res.pinned;
      renderChatList();
      toast(res.pinned ? 'Pinned' : 'Unpinned');
    } else if (action === 'mute') {
      const res = await api.chatSettings({ peer, muted: !chat.muted });
      chat.muted = res.muted;
      renderChatList();
      toast(res.muted ? 'Muted' : 'Unmuted');
    } else if (action === 'archive') {
      const res = await api.chatSettings({ peer, archived: !chat.archived });
      chat.archived = res.archived;
      renderChatList();
      toast(res.archived ? 'Archived' : 'Unarchived');
    } else if (action === 'read') {
      chat.unread = 0;
      await api.markRead(peer);
      renderChatList();
      toast('Marked as read');
    } else if (action === 'clear') {
      const ok = await confirmDialog({
        title: 'Clear history?',
        text: 'All messages in this chat will be removed for you. The other person keeps their copy.',
        confirmLabel: 'Clear'
      });
      if (!ok) return;
      await api.clearChat(peer);
      chat.messages = [];
      chat.last = '';
      chat.lastTs = 0;
      renderMessages();
      renderChatList();
      toast('History cleared');
    } else if (action === 'channel-settings') {
      const channel = isChannelKey(key) ? state.channels.get(channelIdOf(key)) : null;
      if (channel) openChannelSettings(channel.id);
    } else if (action === 'channel-link') {
      const channel = isChannelKey(key) ? state.channels.get(channelIdOf(key)) : null;
      if (channel && channel.handle) {
        try { await navigator.clipboard.writeText('@' + channel.handle); toast('@' + channel.handle + ' скопирован'); }
        catch { toast('Не удалось скопировать'); }
      }
    } else if (action === 'leave') {
      const channel = isChannelKey(key) ? state.channels.get(channelIdOf(key)) : null;
      if (!channel) return;
      const ok = await confirmDialog({
        title: 'Покинуть канал?',
        text: `Вы отпишетесь от «${channel.name}». История исчезнет из списка.`,
        confirmLabel: 'Покинуть'
      });
      if (!ok) return;
      await api.leaveChannel({ channelId: channel.id });
      state.channels.delete(channel.id);
      state.chats.delete(key);
      state.activePeer = null;
      els.chatBlank.hidden = false;
      els.chatView.hidden = true;
      renderChatList();
      toast('Вы покинули канал');
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Delete chat?',
        text: 'This chat and its history will be removed from your list.',
        confirmLabel: 'Delete'
      });
      if (!ok) return;
      if (isMultiKey(key)) {
        // Groups and channels are not DM chats; just drop the row locally.
        state.chats.delete(key);
      } else {
        await api.deleteChat(peer);
        state.chats.delete(key);
      }
      state.activePeer = null;
      els.chatBlank.hidden = false;
      els.chatView.hidden = true;
      renderChatList();
      toast('Chat deleted');
    }
  } catch (err) {
    toast(err.message || 'Something went wrong');
  }
});

els.btnArchivedToggle.addEventListener('click', () => {
  const open = els.archivedList.hidden;
  els.archivedList.hidden = !open;
  els.btnArchivedToggle.classList.toggle('open', open);
});

/* ------------------------------- profile ------------------------------- */
function openMyProfile() {
  showProfile(state.username, { self: true });
}

/* ------------------------------ socials ------------------------------ */
// Social links are plain URLs the user typed; the relay only stores them, so the
// client renders them and must never trust the label to build a link.
const SOCIAL_LABELS = {
  telegram: 'Telegram', instagram: 'Instagram', twitter: 'Twitter / X',
  facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', github: 'GitHub',
  linkedin: 'LinkedIn', vk: 'VK', website: 'Сайт'
};
let socialPending = []; // the links being edited in the profile form

function socialIconId(network) {
  return SOCIAL_LABELS[network] ? `#i-${network === 'website' ? 'globe' : network}` : '#i-globe';
}

/** Paint the chips under the profile name; hidden when there are none. */
function renderProfileSocials(socials) {
  const list = Array.isArray(socials) ? socials : [];
  els.profileSocials.innerHTML = '';
  els.profileSocials.hidden = list.length === 0;
  for (const s of list) {
    if (!s || typeof s.url !== 'string') continue;
    let href;
    try {
      const u = new URL(s.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      href = u.href;
    } catch { continue; }
    const a = document.createElement('a');
    a.className = 'social-chip';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = href;
    a.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="${socialIconId(s.network)}"></use></svg><span></span>`;
    a.querySelector('span').textContent = SOCIAL_LABELS[s.network] || s.network || 'Ссылка';
    els.profileSocials.appendChild(a);
  }
}

/** Redraw the rows in the edit form from `socialPending`. */
function renderSocialEditor() {
  els.profileSocialRows.innerHTML = '';
  socialPending.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'social-row';
    row.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="${socialIconId(s.network)}"></use></svg>
      <span class="social-row-url"></span>
      <button class="btn-ghost btn-compact" type="button" title="Убрать"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-trash"></use></svg></button>`;
    row.querySelector('.social-row-url').textContent = s.url;
    row.querySelector('button').addEventListener('click', () => {
      socialPending.splice(i, 1);
      renderSocialEditor();
    });
    els.profileSocialRows.appendChild(row);
  });
}

els.btnSocialAdd.addEventListener('click', () => {
  const network = els.profileSocialNetwork.value;
  const raw = els.profileSocialUrl.value.trim();
  if (!raw) return;
  let href;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    href = u.href;
  } catch {
    showError(els.profileError, 'Ссылка должна начинаться с http:// или https://');
    return;
  }
  showError(els.profileError, null);
  if (socialPending.some((s) => s.network === network)) {
    showError(els.profileError, 'Эта соцсеть уже добавлена');
    return;
  }
  if (socialPending.length >= 8) {
    showError(els.profileError, 'Можно добавить не больше 8 ссылок');
    return;
  }
  socialPending.push({ network, url: href });
  els.profileSocialUrl.value = '';
  renderSocialEditor();
});

/* ------------------------------ nicknames ------------------------------ */
// Extra display names under the profile name. Only the owner account may hold
// an unbounded list, and only administrators get the panel to edit anyone's;
// the relay enforces both, the client only reflects them.
let nicknamePending = []; // the names being edited in the profile form

/** Paint the nickname chips under the profile name; hidden when there are none. */
function renderProfileNicknames(nicknames) {
  const list = Array.isArray(nicknames) ? nicknames : [];
  els.profileNicknames.innerHTML = '';
  els.profileNicknames.hidden = list.length === 0;
  for (const n of list) {
    if (typeof n !== 'string' || !n.trim()) continue;
    const chip = document.createElement('span');
    chip.className = 'nickname-chip';
    chip.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"></use></svg><span></span>';
    chip.querySelector('span').textContent = n;
    els.profileNicknames.appendChild(chip);
  }
}

/** Redraw the rows in the edit form from `nicknamePending`. */
function renderNicknameEditor() {
  els.profileNicknameRows.innerHTML = '';
  nicknamePending.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'social-row nickname-row';
    row.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-star"></use></svg>
      <span class="nickname-row-name"></span>
      <button class="btn-ghost btn-compact" type="button" title="Убрать"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-trash"></use></svg></button>`;
    row.querySelector('.nickname-row-name').textContent = name;
    row.querySelector('button').addEventListener('click', () => {
      nicknamePending.splice(i, 1);
      renderNicknameEditor();
    });
    els.profileNicknameRows.appendChild(row);
  });
}

els.btnNicknameAdd.addEventListener('click', () => {
  const name = (els.profileNicknameInput.value || '').trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (name.length > 32) {
    showError(els.profileError, 'Никнейм слишком длинный (до 32 символов)');
    return;
  }
  if (nicknamePending.some((n) => n.toLowerCase() === name.toLowerCase())) {
    showError(els.profileError, 'Такой никнейм уже есть');
    return;
  }
  showError(els.profileError, null);
  nicknamePending.push(name);
  els.profileNicknameInput.value = '';
  renderNicknameEditor();
});

async function showProfile(username, { self = false } = {}) {
  state.profileTarget = username;
  state.editingProfile = false;
  els.profileBackdrop.hidden = false;
  els.profileForm.hidden = true;
  els.profileView.hidden = false;
  els.usernameBlock.hidden = !self;
  els.usernameSep.hidden = !self;
  els.profileTitle.textContent = self ? 'My profile' : 'Profile';
  showError(els.profileError, null);
  showError(els.usernameError, null);
  els.usernameInput.value = '';

  let info = { profile: state.profiles.get(username) || { username, displayName: username, bio: '', avatarColor: 'mint' }, online: state.presence.get(username), isSelf: self };
  try { info = await api.getProfile(username); } catch { /* use cache */ }

  const p = info.profile;
  state.profiles.set(p.username, p);
  if (typeof info.online === 'boolean') state.presence.set(p.username, info.online);
  if (info.lastSeen) state.lastSeen.set(p.username, info.lastSeen);
  const isSelf = info.isSelf || self;

  // Read the picture straight from the fetched profile: the cache was just
  // seeded with it, and paintAvatar falls back to the initial when absent.
  els.profileAvatar.className = 'avatar avatar-xl';
  els.profileAvatar.dataset.color = p.avatarColor || 'mint';
  els.profileAvatar.innerHTML = avatarInnerHtml(p.username, p);
  els.profileDisplay.textContent = p.displayName || p.username;
  els.profileHandle.textContent = '@' + p.username;
  paintBadge(els.profileBadge, p.username);
  els.profileViewUsername.textContent = atUsername(p.username);
  els.profileViewBio.textContent = p.bio || '—';
  renderProfileSocials(p.socials);
  renderProfileNicknames(p.nicknames);
  const presenceText = peerPresenceText(p.username);
  els.profilePresence.textContent = isSelf ? 'Это вы' : (presenceText || 'не в сети');
  els.profilePresence.classList.toggle('online', !isSelf && !!info.online);
  renderProfileStreak(p.username);
  els.profileViewBio.parentElement.hidden = false;

  els.btnProfileMessage.hidden = isSelf;
  els.btnProfileEdit.hidden = !isSelf;
  els.profileActions.hidden = false;

  // Fill the edit form for later use.
  els.profileName.value = p.displayName || '';
  els.profileBio.value = p.bio || '';
  buildSwatches(p.avatarColor || 'mint');
  avatarPending = undefined;
  paintAvatarPicker();
  renderPubkey(p.username);
}

/** Repaint just the presence line of the open profile overlay. */
function refreshProfilePresence(username) {
  if (username === state.username) return;
  const text = peerPresenceText(username);
  els.profilePresence.textContent = text || 'не в сети';
  els.profilePresence.classList.toggle('online', !!state.presence.get(username));
}

async function renderPubkey(username) {
  els.profilePubkey.textContent = '…';
  try {
    const res = await api.directory(username);
    els.profilePubkey.textContent = res.publicKey || '—';
  } catch {
    els.profilePubkey.textContent = '—';
  }
}

/* --------------------------- avatar image --------------------------- */
// A profile picture is picked, pasted or dropped, downscaled on this device,
// and stored as a small data: URL, exactly like the admin badge picture.
const AVATAR_MAX_SIDE = 256;
const AVATAR_MAX_CHARS = 64 * 1024;
let avatarPending; // undefined = unchanged, null = cleared, string = new image

function paintAvatarPicker() {
  const current = avatarPending !== undefined ? avatarPending : (state.profile && state.profile.avatarImage) || null;
  els.btnAvatarClear.hidden = !current;
  els.avatarPreview.className = 'avatar avatar-lg';
  if (current) {
    els.avatarPreview.dataset.color = 'mint';
    els.avatarPreview.innerHTML = `<img class="avatar-img" src="${escapeHtml(current)}" alt="" />`;
  } else {
    els.avatarPreview.dataset.color = (state.profile && state.profile.avatarColor) || 'mint';
    els.avatarPreview.textContent = initial((state.profile && state.profile.displayName) || state.username || '?');
  }
}

function downscaleAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Это не похоже на картинку'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const size = Math.min(AVATAR_MAX_SIDE, side);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function acceptAvatarFile(file) {
  if (!file) return;
  els.avatarHint.textContent = 'PNG, JPEG или WebP. Можно вставить Ctrl+V.';
  if (!/^image\//.test(file.type || '')) {
    els.avatarHint.textContent = 'Нужна картинка (PNG, JPEG или WebP)';
    return;
  }
  try {
    const dataUrl = await downscaleAvatar(file);
    if (dataUrl.length > AVATAR_MAX_CHARS) {
      els.avatarHint.textContent = 'Картинка слишком большая';
      return;
    }
    avatarPending = dataUrl;
    paintAvatarPicker();
  } catch (err) {
    els.avatarHint.textContent = err.message || 'Не удалось обработать картинку';
  }
}

els.btnAvatarPick.addEventListener('click', async () => {
  acceptAvatarFile(await pickFile('image/*'));
});
els.btnAvatarClear.addEventListener('click', () => {
  avatarPending = null;
  paintAvatarPicker();
});
els.avatarPreview.addEventListener('click', async () => {
  acceptAvatarFile(await pickFile('image/*'));
});
els.profileForm.addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      acceptAvatarFile(item.getAsFile());
      return;
    }
  }
});
for (const evt of ['dragenter', 'dragover']) {
  els.avatarPreview.addEventListener(evt, (e) => {
    e.preventDefault();
    els.avatarPreview.parentElement.classList.add('is-drag');
  });
}
for (const evt of ['dragleave', 'drop']) {
  els.avatarPreview.addEventListener(evt, (e) => {
    e.preventDefault();
    els.avatarPreview.parentElement.classList.remove('is-drag');
  });
}
els.avatarPreview.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  acceptAvatarFile(file);
});

function buildSwatches(selected) {
  els.profileColors.innerHTML = '';
  for (const color of AVATAR_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (color === selected ? ' selected' : '');
    b.dataset.color = color;
    b.style.background = `var(--swatch-${color})`;
    b.title = color;
    b.addEventListener('click', () => {
      els.profileColors.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
      b.classList.add('selected');
    });
    els.profileColors.appendChild(b);
  }
}

/** Close the profile overlay and stop it from reopening on the next event. */
function closeProfile() {
  els.profileBackdrop.hidden = true;
  state.profileTarget = null;
}

els.btnMyProfile.addEventListener('click', openMyProfile);
els.btnOpenMyProfile.addEventListener('click', () => { els.settingsBackdrop.hidden = true; openMyProfile(); });
els.btnProfileClose.addEventListener('click', closeProfile);
els.profileBackdrop.addEventListener('click', (e) => {
  if (e.target === els.profileBackdrop) closeProfile();
});
els.btnPeerProfile.addEventListener('click', () => {
  if (!state.activePeer || state.activePeer === SAVED) return;
  showProfile(peerUsername(state.activePeer));
});
els.btnProfileMessage.addEventListener('click', () => {
  const target = state.profileTarget;
  closeProfile();
  if (target) startChatWith(target);
});

els.btnProfileEdit.addEventListener('click', () => {
  state.editingProfile = true;
  els.profileView.hidden = true;
  els.profileForm.hidden = false;
  els.usernameBlock.hidden = true;
  els.usernameSep.hidden = true;
  // Seed the socials editor from the live self profile.
  socialPending = Array.isArray(state.profile && state.profile.socials)
    ? state.profile.socials.map((s) => ({ network: s.network, url: s.url }))
    : [];
  renderSocialEditor();
  // The nickname editor is the owner's privilege, mirroring the relay.
  const owner = !!(state.profile && state.profile.owner);
  els.nicknamesField.hidden = !owner;
  nicknamePending = owner && Array.isArray(state.profile && state.profile.nicknames)
    ? state.profile.nicknames.slice()
    : [];
  renderNicknameEditor();
  showError(els.profileError, null);
  els.profileName.focus();
});

els.btnProfileCancel.addEventListener('click', () => {
  state.editingProfile = false;
  els.profileForm.hidden = true;
  els.profileView.hidden = false;
  els.usernameBlock.hidden = false;
  els.usernameSep.hidden = false;
});

els.profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.profileError, null);
  const selected = els.profileColors.querySelector('.swatch.selected');
  try {
    const p = await api.saveProfile({
      displayName: els.profileName.value,
      bio: els.profileBio.value,
      avatarColor: selected ? selected.dataset.color : undefined,
      avatarImage: avatarPending === undefined ? undefined : avatarPending,
      socials: socialPending,
      nicknames: state.profile && state.profile.owner ? nicknamePending : undefined
    });
    state.profile = p;
    state.profiles.set(p.username, p);
    applySelfProfile(p);
    state.editingProfile = false;
    els.profileForm.hidden = true;
    els.profileView.hidden = false;
    els.usernameBlock.hidden = false;
    els.usernameSep.hidden = false;
    showProfile(state.username, { self: true });
    toast('Profile saved');
  } catch (err) {
    showError(els.profileError, err.message || 'Could not save profile');
  }
});

els.btnUsernameSave.addEventListener('click', async () => {
  const next = bareUsername(els.usernameInput.value);
  showError(els.usernameError, null);
  if (!USERNAME_RE.test(next)) {
    return showError(els.usernameError, 'Username: 3–32 characters, a–z, 0–9 or _');
  }
  if (next === state.username) return showError(els.usernameError, 'That is already your username');
  els.btnUsernameSave.disabled = true;
  try {
    const res = await api.changeUsername(next);
    const old = res.previous;
    state.username = res.username;
    // Re-key Saved Messages and the profile cache to the new name.
    const savedChat = state.chats.get(SAVED);
    if (savedChat) { state.chats.delete(SAVED); state.chats.set(res.username, savedChat); }
    if (state.activePeer === SAVED) state.activePeer = res.username;
    state.profiles.delete(old);
    els.usernameInput.value = '';
    await refreshStatus();
    renderChatList();
    if (state.activePeer) { els.peerName.textContent = displayNameFor(state.activePeer); paintAvatar(els.peerAvatar, state.activePeer); }
    showProfile(res.username, { self: true });
    toast('Username changed to @' + res.username);
  } catch (err) {
    showError(els.usernameError, err.message || 'Could not change username');
  } finally {
    els.btnUsernameSave.disabled = false;
  }
});

function applySelfProfile(p) {
  state.profile = p;
  // The relay filters a hidden profile for everyone but the owner; when the
  // owner's own view arrives with the switch on, keep the settings controls in
  // step with what the relay is enforcing.
  syncPrivacyUI(p);
  if (p.username === state.username) {
    els.meName.textContent = p.displayName || p.username;
    paintAvatar(els.meAvatar, p.username);
    els.setUsername.textContent = '@' + p.username;
    if (els.setAccountHandle) els.setAccountHandle.textContent = '@' + p.username;
    paintBadge(els.meBadge, p.username);
    if (els.setHeroAvatar) paintAvatar(els.setHeroAvatar, p.username, 'avatar-lg');
    if (els.setHeroName) els.setHeroName.textContent = p.displayName || p.username;
    if (typeof p.streak === 'number') {
      state.streak = { count: p.streak, active: !!p.streakActive };
      renderSelfStreak();
    }
    setAdminMode(!!p.admin || !!p.adminByConfig);
  }
}

/** Show or hide the admin section, and refresh it when it becomes visible. */
function setAdminMode(on) {
  if (state.isAdmin === on) { if (on && state.settingsPane === 'admin') loadAdminPanel(); return; }
  state.isAdmin = on;
  els.settingsNavAdmin.hidden = !on;
  // The pane itself may be hidden by a live toggle, not only the nav entry.
  const pane = document.querySelector('.settings-pane[data-pane="admin"]');
  if (pane) pane.hidden = !on;
  if (!on && state.settingsPane === 'admin') selectSettingsPane('account');
}

/** Tell the user their account was blocked or deleted, and return to sign-in. */
function handleKicked(reason) {
  toast(reason || 'Disconnected by an administrator', 6000);
  state.isAdmin = false;
  els.settingsBackdrop.hidden = true;
  setTimeout(() => { showScreen('auth'); }, 1200);
}

/* ------------------------------- settings ------------------------------- */
els.btnSettings.addEventListener('click', () => {
  els.settingsBackdrop.hidden = false;
  els.setServer.value = els.serverUrl.value;
  if (els.setVersionSub) els.setVersionSub.textContent = `Версия ${els.footVer.textContent.replace(/^v/, '')} · сквозное шифрование`;
  selectSettingsPane(state.settingsPane);
  syncSettingsUI();
  refreshPasswordUI();
  api.status().then((s) => {
    els.setPubkey.textContent = s.publicKey || '—';
    updateConnIndicators(s.online);
  });
});

/** Mirror the relay's privacy switches into the settings controls. */
function syncPrivacyUI(profile) {
  const p = (profile && profile.privacy) || null;
  if (!p || !els.setLastSeen || !els.setHideProfile) return;
  els.setLastSeen.checked = !p.lastSeenHidden;
  els.setHideProfile.checked = !!p.profileHidden;
  state.settings.hideLastSeen = !!p.lastSeenHidden;
  state.settings.hideProfile = !!p.profileHidden;
}

/** Mirror the stored settings into the settings controls. */
function syncSettingsUI() {
  const s = state.settings;
  els.setNotify.checked = s.notify !== false;
  els.setPreview.checked = s.notifyPreview !== false;
  els.setSound.checked = s.notifySound !== false;
  els.setLastSeen.checked = s.hideLastSeen !== true;
  els.setHideProfile.checked = s.hideProfile === true;
  els.setReceipts.checked = s.readReceipts !== false;
  els.setAutoLock.value = String(s.autoLock || 0);
  els.setAutoPhoto.checked = s.autoDownloadPhotos !== false;
  els.setKeepMedia.value = s.keepMedia || 'month';
  els.setEnter.checked = s.sendWithEnter !== false;
  els.setLanguage.value = s.language || 'ru';
  els.setChatPreview.checked = s.chatPreview !== false;
  els.setReduceMotion.checked = s.reduceMotion === true;
  els.setEscClose.checked = s.escClose !== false;
  els.setPlainPaste.checked = s.plainPaste === true;
  const blocked = Array.isArray(s.blocked) ? s.blocked : [];
  els.setBlockedSub.textContent = blocked.length ? `${blocked.length} blocked` : 'Никто не заблокирован';
  updateStorageLabel();
}

/* ------------------------- settings navigation ------------------------- */
// Telegram-style: a list of sections on the left, one pane on the right.

function selectSettingsPane(name) {
  state.settingsPane = name;
  els.settingsNav.querySelectorAll('.settings-nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.pane === name);
  });
  els.settingsPanes.querySelectorAll('.settings-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.pane === name);
  });
  if (name === 'admin') loadAdminPanel();
}

els.settingsNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-nav-item');
  if (btn) selectSettingsPane(btn.dataset.pane);
});

/** Render the admin summary and user table from the relay. */
async function loadAdminPanel() {
  if (!state.isAdmin) return;
  els.adminUsers.innerHTML = '<p class="panel-empty">Загрузка…</p>';
  els.adminUsersEmpty.hidden = true;
  try {
    const [{ stats, announcements }, users, channels] = await Promise.all([
      api.adminOverview(),
      api.adminUsers(),
      api.adminChannels().catch(() => [])
    ]);
    els.adminStats.innerHTML = `
      <div class="admin-stat"><span class="admin-stat-num">${stats.users}</span><span class="admin-stat-label">Пользователей</span></div>
      <div class="admin-stat"><span class="admin-stat-num">${stats.online}</span><span class="admin-stat-label">Онлайн</span></div>
      <div class="admin-stat"><span class="admin-stat-num">${stats.messages}</span><span class="admin-stat-label">Сообщений</span></div>
      <div class="admin-stat"><span class="admin-stat-num">${stats.groups}</span><span class="admin-stat-label">Групп</span></div>
      <div class="admin-stat"><span class="admin-stat-num">${stats.channels || 0}</span><span class="admin-stat-label">Каналов</span></div>
    `;
    state.adminUsers = users;
    state.adminChannels = channels;
    state.adminAnnounceCount = announcements.length;
    renderAdminUsers();
    renderAdminChannels();
  } catch (err) {
    els.adminUsers.innerHTML = '';
    els.adminUsersEmpty.hidden = false;
    els.adminUsersEmpty.textContent = err.message || 'Не удалось загрузить панель';
  }
}

/** A short "· ник: A, B" suffix for the admin list, when the account has any. */
function nicknameSummary(nicknames) {
  const list = Array.isArray(nicknames) ? nicknames : [];
  if (!list.length) return '';
  const shown = list.slice(0, 3).join(', ');
  const more = list.length > 3 ? ` +${list.length - 3}` : '';
  return ` · <span class="admin-nick-summary">${escapeHtml(shown + more)}</span>`;
}

/** Draw the user list, honouring the search box. */
function renderAdminUsers() {
  const query = (els.adminUsersSearch.value || '').trim().toLowerCase();
  const users = (state.adminUsers || []).filter((u) =>
    !query || u.username.toLowerCase().includes(query) ||
    (u.displayName || '').toLowerCase().includes(query)
  );
  els.adminUsers.innerHTML = '';
  els.adminUsersCount.textContent = String((state.adminUsers || []).length);
  els.adminUsersEmpty.hidden = users.length > 0;
  if (!users.length) {
    els.adminUsersEmpty.textContent = query ? 'Никого не найдено.' : 'Пользователей пока нет.';
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'admin-user';
    if (u.banned) row.classList.add('is-banned');
    const flags = [
      u.admin ? '<span class="admin-tag admin">админ</span>' : '',
      u.verified ? '<span class="admin-tag verified">проверен</span>' : '',
      u.banned ? '<span class="admin-tag banned">заблокирован</span>' : '',
      u.online ? '<span class="admin-tag online">онлайн</span>' : ''
    ].filter(Boolean).join(' ');
    row.innerHTML = `
      <div class="avatar small" data-color="${escapeHtml(u.avatarColor || 'mint')}">${avatarInnerHtml(u.username, u)}</div>
      <div class="admin-user-body">
        <div class="admin-user-name">${escapeHtml(u.displayName || u.username)} ${flags}</div>
        <div class="admin-user-sub"><span class="admin-at" data-user="${escapeHtml(u.username)}" title="Наведите, чтобы менять никнеймы">@${escapeHtml(u.username)}</span> · ${u.sent} сообщ.${nicknameSummary(u.nicknames)}</div>
      </div>
      <div class="admin-user-actions">
        <button class="admin-act${u.verified ? ' on' : ''}" data-act="verify" data-user="${escapeHtml(u.username)}" title="${u.verified ? 'Снять галочку' : 'Дать галочку'}">${icon('i-check')}</button>
        <button class="admin-act${u.badgeImage ? ' on' : ''}" data-act="badge" data-user="${escapeHtml(u.username)}" title="${u.badgeImage ? 'Заменить значок' : 'Свой значок вместо галочки'}">${icon('i-image')}</button>
        <button class="admin-act${u.admin ? ' on' : ''}" data-act="grantAdmin" data-user="${escapeHtml(u.username)}" title="${u.admin ? 'Снять админа' : 'Сделать админом'}">${icon('i-shield')}</button>
        <button class="admin-act danger${u.banned ? ' on' : ''}" data-act="ban" data-user="${escapeHtml(u.username)}" title="${u.banned ? 'Разблокировать' : 'Заблокировать'}">${icon('i-ban')}</button>
        <button class="admin-act danger" data-act="delete" data-user="${escapeHtml(u.username)}" title="Удалить">${icon('i-trash')}</button>
      </div>
    `;
    els.adminUsers.appendChild(row);
  }
}

/** Draw the channel list, honouring the search box. */
function renderAdminChannels() {
  const query = (els.adminChannelsSearch.value || '').trim().toLowerCase();
  const channels = (state.adminChannels || []).filter((c) =>
    !query || c.name.toLowerCase().includes(query) || (c.owner || '').toLowerCase().includes(query)
  );
  els.adminChannels.innerHTML = '';
  els.adminChannelsCount.textContent = String((state.adminChannels || []).length);
  els.adminChannelsEmpty.hidden = channels.length > 0;
  if (!channels.length) {
    els.adminChannelsEmpty.textContent = query ? 'Ничего не найдено.' : 'Каналов пока нет.';
    return;
  }
  for (const c of channels) {
    const row = document.createElement('div');
    row.className = 'admin-user';
    const flags = [
      c.verified ? '<span class="admin-tag verified">проверен</span>' : ''
    ].filter(Boolean).join(' ');
    row.innerHTML = `
      <div class="avatar small" data-color="cyan">${icon('i-globe')}</div>
      <div class="admin-user-body">
        <div class="admin-user-name">${escapeHtml(c.name)} ${flags}</div>
        <div class="admin-user-sub">@${escapeHtml(c.owner)} · ${c.subs} подписчиков</div>
      </div>
      <div class="admin-user-actions">
        <button class="admin-act${c.verified ? ' on' : ''}" data-act="channelVerify" data-channel="${c.id}" title="${c.verified ? 'Снять галочку канала' : 'Дать каналу галочку'}">${icon('i-check')}</button>
        <button class="admin-act danger" data-act="channelDelete" data-channel="${c.id}" title="Удалить канал">${icon('i-trash')}</button>
      </div>
    `;
    els.adminChannels.appendChild(row);
  }
}

els.adminChannels.addEventListener('click', async (e) => {
  const btn = e.target.closest('.admin-act');
  if (!btn) return;
  const act = btn.dataset.act;
  const channelId = Number(btn.dataset.channel);
  const row = (state.adminChannels || []).find((c) => c.id === channelId);
  if (act === 'channelDelete') {
    const ok = await confirmDialog({
      title: 'Удалить канал?',
      text: `Канал «${row ? row.name : channelId}» и все его посты будут удалены у всех подписчиков.`,
      confirmLabel: 'Удалить'
    });
    if (!ok) return;
  }
  try {
    await api.adminAction({ action: act, channelId });
    toast('Готово');
    loadAdminPanel();
  } catch (err) {
    toast(err.message || 'Не удалось выполнить действие');
  }
});
els.adminChannelsSearch.addEventListener('input', renderAdminChannels);

/* --------------------------- badge image dialog --------------------------- */
// An admin can give an account its own round picture in place of the checkmark.
// The picture is pasted from the clipboard or picked from a file, downscaled on
// this device, and stored as a small data: URL.
const BADGE_MAX_SIDE = 128;
const BADGE_MAX_CHARS = 128 * 1024;
let badgeTarget = null;
let badgePending = null;

function badgeDialogOpen(username, current) {
  badgeTarget = username;
  badgePending = current || null;
  els.badgeError.hidden = true;
  els.badgeError.textContent = '';
  els.btnBadgeRemove.hidden = !current;
  paintBadgePreview(badgePending);
  els.badgeBackdrop.hidden = false;
  els.badgeDrop.focus();
}

function badgeDialogClose() {
  els.badgeBackdrop.hidden = true;
  badgeTarget = null;
  badgePending = null;
}

function paintBadgePreview(dataUrl) {
  if (dataUrl) {
    els.badgePreviewImg.src = dataUrl;
    els.badgePreview.hidden = false;
    els.badgeDropHint.textContent = 'Картинка выбрана. Можно вставить другую.';
  } else {
    els.badgePreviewImg.removeAttribute('src');
    els.badgePreview.hidden = true;
    els.badgeDropHint.textContent = 'Ctrl+V — вставить · или нажмите, чтобы выбрать файл';
  }
}

/** Shrink a picture to a small square so the stored data: URL stays tiny. */
function downscaleBadge(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Это не похоже на картинку'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const size = Math.min(BADGE_MAX_SIDE, side);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Crop to a centred square so the round badge is not distorted.
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function acceptBadgeFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) {
    els.badgeError.textContent = 'Нужна картинка (PNG, JPEG, GIF или WebP)';
    els.badgeError.hidden = false;
    return;
  }
  try {
    const dataUrl = await downscaleBadge(file);
    if (dataUrl.length > BADGE_MAX_CHARS) {
      els.badgeError.textContent = 'Картинка слишком большая';
      els.badgeError.hidden = false;
      return;
    }
    badgePending = dataUrl;
    els.badgeError.hidden = true;
    els.btnBadgeRemove.hidden = false;
    paintBadgePreview(dataUrl);
  } catch (err) {
    els.badgeError.textContent = err.message || 'Не удалось обработать картинку';
    els.badgeError.hidden = false;
  }
}

els.badgeDrop.addEventListener('click', async () => {
  const file = await pickFile('image/*');
  acceptBadgeFile(file);
});

els.badgeDrop.addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      acceptBadgeFile(item.getAsFile());
      return;
    }
  }
});

for (const evt of ['dragenter', 'dragover']) {
  els.badgeDrop.addEventListener(evt, (e) => { e.preventDefault(); els.badgeDrop.classList.add('is-drag'); });
}
for (const evt of ['dragleave', 'drop']) {
  els.badgeDrop.addEventListener(evt, (e) => { e.preventDefault(); els.badgeDrop.classList.remove('is-drag'); });
}
els.badgeDrop.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  acceptBadgeFile(file);
});

els.btnBadgeSave.addEventListener('click', async () => {
  if (!badgeTarget) return;
  try {
    await api.adminAction({ action: 'badge', username: badgeTarget, image: badgePending });
    badgeDialogClose();
    toast('Значок сохранён');
    loadAdminPanel();
  } catch (err) {
    els.badgeError.textContent = err.message || 'Не удалось сохранить значок';
    els.badgeError.hidden = false;
  }
});

els.btnBadgeRemove.addEventListener('click', async () => {
  if (!badgeTarget) return;
  try {
    await api.adminAction({ action: 'badge', username: badgeTarget, image: null });
    badgeDialogClose();
    toast('Значок убран');
    loadAdminPanel();
  } catch (err) {
    els.badgeError.textContent = err.message || 'Не удалось убрать значок';
    els.badgeError.hidden = false;
  }
});

els.btnBadgeCancel.addEventListener('click', badgeDialogClose);
els.badgeBackdrop.addEventListener('click', (e) => {
  if (e.target === els.badgeBackdrop) badgeDialogClose();
});

els.adminUsers.addEventListener('click', async (e) => {
  const btn = e.target.closest('.admin-act');
  if (!btn) return;
  const { act, user } = btn.dataset;
  if (act === 'badge') {
    const row = (state.adminUsers || []).find((u) => u.username === user);
    badgeDialogOpen(user, row && row.badgeImage);
    return;
  }
  if (act === 'delete') {
    const ok = await confirmDialog({
      title: 'Удалить аккаунт?',
      text: `Аккаунт @${user} и все его сообщения будут удалены безвозвратно.`,
      confirmLabel: 'Удалить'
    });
    if (!ok) return;
  }
  try {
    await api.adminAction({ action: act, username: user });
    if (act === 'grantAdmin' && user === state.username) {
      // Toggling your own admin flag must not hide the panel you are using.
      toast('Готово. Пункт «Админ-панель» остаётся у аккаунтов из SLEEPHY_ADMINS.');
    } else {
      toast('Готово');
    }
    loadAdminPanel();
  } catch (err) {
    toast(err.message || 'Не удалось выполнить действие');
  }
});

els.adminUsersSearch.addEventListener('input', renderAdminUsers);
els.btnAdminRefresh.addEventListener('click', () => loadAdminPanel());

/* ------------------- admin: nickname editor popup ------------------- */
// Hovering an @handle in the admin list opens a small popup where an admin can
// add, rename or remove that account's nicknames. The relay enforces who may do
// this; the popup only appears for an administrator.
let nickPop = null;       // the open popup element
let nickPopUser = null;   // whose nicknames it is editing
let nickPopTimer = null;  // the close delay, so moving the mouse in is possible

function nicknamesFor(username) {
  const u = (state.adminUsers || []).find((x) => x.username === username);
  return u && Array.isArray(u.nicknames) ? u.nicknames.slice() : [];
}

function closeNickPop() {
  if (nickPopTimer) { clearTimeout(nickPopTimer); nickPopTimer = null; }
  if (nickPop) { nickPop.remove(); nickPop = null; }
  nickPopUser = null;
}

/** Keep the popup open while the pointer is over it, close it a beat later. */
function scheduleNickPopClose() {
  if (nickPopTimer) clearTimeout(nickPopTimer);
  nickPopTimer = setTimeout(closeNickPop, 180);
}

function openNickPop(anchor, username) {
  if (nickPopTimer) { clearTimeout(nickPopTimer); nickPopTimer = null; }
  if (nickPopUser === username && nickPop) return;
  closeNickPop();
  nickPopUser = username;
  const pop = document.createElement('div');
  pop.className = 'nick-pop';
  pop.addEventListener('mouseenter', () => { if (nickPopTimer) { clearTimeout(nickPopTimer); nickPopTimer = null; } });
  pop.addEventListener('mouseleave', scheduleNickPopClose);
  document.body.appendChild(pop);
  nickPop = pop;
  renderNickPop();
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - 300);
  const top = Math.min(r.bottom + 6, window.innerHeight - 40);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

function renderNickPop() {
  if (!nickPop || !nickPopUser) return;
  const list = nicknamesFor(nickPopUser);
  nickPop.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'nick-pop-title';
  title.textContent = `Никнеймы @${nickPopUser}`;
  nickPop.appendChild(title);

  const listBox = document.createElement('div');
  listBox.className = 'nick-pop-list';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'nick-pop-empty';
    empty.textContent = 'Пока нет.';
    listBox.appendChild(empty);
  }
  list.forEach((name, i) => {
    const item = document.createElement('div');
    item.className = 'nick-pop-item';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 32;
    input.value = name;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveNicknameEdit(i, input.value); }
      if (e.key === 'Escape') { e.preventDefault(); closeNickPop(); }
    });
    input.addEventListener('blur', () => {
      if (input.value.trim() && input.value.trim() !== name) saveNicknameEdit(i, input.value);
    });
    const del = document.createElement('button');
    del.className = 'admin-act danger';
    del.title = 'Убрать';
    del.innerHTML = icon('i-trash');
    del.addEventListener('click', () => removeNickname(i));
    item.appendChild(input);
    item.appendChild(del);
    listBox.appendChild(item);
  });
  nickPop.appendChild(listBox);

  const addRow = document.createElement('div');
  addRow.className = 'nick-pop-add';
  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.maxLength = 32;
  addInput.placeholder = 'Новый никнейм';
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addNickname(addInput.value); }
    if (e.key === 'Escape') { e.preventDefault(); closeNickPop(); }
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-secondary btn-compact';
  addBtn.type = 'button';
  addBtn.textContent = 'Добавить';
  addBtn.addEventListener('click', () => addNickname(addInput.value));
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  nickPop.appendChild(addRow);
}

async function addNickname(raw) {
  const name = (raw || '').trim();
  if (!name || !nickPopUser) return;
  const user = nickPopUser;
  try {
    await api.adminAction({ action: 'nicknameAdd', username: user, nickname: name });
    await loadAdminPanel();
    if (nickPopUser === user) renderNickPop();
    toast('Никнейм добавлен');
  } catch (err) {
    toast(err.message || 'Не удалось добавить никнейм');
  }
}

async function removeNickname(index) {
  if (!nickPopUser) return;
  const user = nickPopUser;
  try {
    await api.adminAction({ action: 'nicknameRemove', username: user, index });
    await loadAdminPanel();
    if (nickPopUser === user) renderNickPop();
  } catch (err) {
    toast(err.message || 'Не удалось убрать никнейм');
  }
}

async function saveNicknameEdit(index, raw) {
  if (!nickPopUser) return;
  const name = (raw || '').trim();
  if (!name) return;
  const user = nickPopUser;
  try {
    await api.adminAction({ action: 'nicknameSet', username: user, nickname: name, index });
    await loadAdminPanel();
    if (nickPopUser === user) renderNickPop();
    toast('Никнейм изменён');
  } catch (err) {
    toast(err.message || 'Не удалось изменить никнейм');
  }
}

els.adminUsers.addEventListener('mouseover', (e) => {
  const at = e.target.closest && e.target.closest('.admin-at');
  if (at) openNickPop(at, at.dataset.user);
});
els.adminUsers.addEventListener('mouseout', (e) => {
  const at = e.target.closest && e.target.closest('.admin-at');
  if (at) scheduleNickPopClose();
});
// A click anywhere outside the popup dismisses it.
document.addEventListener('mousedown', (e) => {
  if (!nickPop) return;
  if (nickPop.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.admin-at')) return;
  closeNickPop();
});

els.btnAdminAnnounce.addEventListener('click', async () => {
  const text = els.adminAnnounceInput.value.trim();
  if (!text) return;
  try {
    await api.adminAction({ action: 'announce', text });
    els.adminAnnounceInput.value = '';
    toast('Объявление отправлено');
  } catch (err) {
    toast(err.message || 'Не удалось отправить объявление');
  }
});

function playTestSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch { /* audio is unavailable in some environments */ }
}
els.btnTestSound.addEventListener('click', playTestSound);

/** Approximate the local cache footprint from attachment sizes we know about. */
function updateStorageLabel() {
  let bytes = 0;
  for (const chat of state.chats.values()) {
    for (const m of chat.messages) {
      if (m.attachment && m.attachment.size) bytes += m.attachment.size;
    }
  }
  els.setStorage.textContent = bytes ? humanSize(bytes) : 'Nothing cached';
}

/** Wire one settings toggle to a boolean key on the account settings. */
function bindToggle(el, key, invert = false) {
  el.addEventListener('change', async () => {
    await persistSettings({ [key]: invert ? !el.checked : el.checked });
  });
}
bindToggle(els.setNotify, 'notify');
bindToggle(els.setPreview, 'notifyPreview');
bindToggle(els.setSound, 'notifySound');
bindToggle(els.setReceipts, 'readReceipts');
bindToggle(els.setAutoPhoto, 'autoDownloadPhotos');
bindToggle(els.setEnter, 'sendWithEnter');
bindToggle(els.setChatPreview, 'chatPreview');
bindToggle(els.setEscClose, 'escClose');
bindToggle(els.setPlainPaste, 'plainPaste');

/**
 * Privacy switches are enforced by the relay, so they must round-trip through
 * `privacy.set` rather than the cosmetic settings store. `set-lastseen` is
 * inverted: checked means "show my last seen", so hiding is `!checked`.
 */
async function persistPrivacy(patch) {
  try {
    await api.setPrivacy(patch);
  } catch { /* keep the local value; the relay will correct it on next login */ }
  await persistSettings({
    hideLastSeen: els.setLastSeen.checked === false,
    hideProfile: els.setHideProfile.checked === true
  });
}

els.setLastSeen.addEventListener('change', () => persistPrivacy({ lastSeenHidden: !els.setLastSeen.checked }));
els.setHideProfile.addEventListener('change', () => persistPrivacy({ profileHidden: els.setHideProfile.checked }));

// "Reduce motion" is applied straight to the document, not just stored.
els.setReduceMotion.addEventListener('change', async () => {
  document.documentElement.classList.toggle('reduce-motion', els.setReduceMotion.checked);
  await persistSettings({ reduceMotion: els.setReduceMotion.checked });
});

els.btnReconnect.addEventListener('click', async () => {
  try {
    await api.connect(els.setServer.value.trim() || els.serverUrl.value.trim());
    toast('Переподключено');
  } catch {
    toast('Не удалось подключиться');
  }
});

els.btnCheckUpdates.addEventListener('click', () => {
  toast('У вас последняя версия');
});

els.btnResetSettings.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Сбросить настройки?',
    text: 'Все настройки вернутся к значениям по умолчанию.',
    confirmLabel: 'Сбросить'
  });
  if (!ok) return;
  await persistSettings({
    notify: true, notifyPreview: true, notifySound: true, lastSeen: true,
    readReceipts: true, autoDownloadPhotos: true, sendWithEnter: true,
    chatPreview: true, escClose: true, plainPaste: false, reduceMotion: false,
    autoLock: 0, keepMedia: 'month', blocked: []
  });
  document.documentElement.classList.remove('reduce-motion');
  syncSettingsUI();
  toast('Настройки сброшены');
});

els.setAutoLock.addEventListener('change', async () => {
  await persistSettings({ autoLock: Number(els.setAutoLock.value) || 0 });
});
els.setKeepMedia.addEventListener('change', async () => {
  await persistSettings({ keepMedia: els.setKeepMedia.value });
});
els.setLanguage.addEventListener('change', async () => {
  applyLanguage(els.setLanguage.value);
  await persistSettings({ language: els.setLanguage.value });
});

els.btnClearCache.addEventListener('click', async () => {
  for (const chat of state.chats.values()) {
    for (const m of chat.messages) { delete m.dataUrl; }
  }
  renderMessages();
  updateStorageLabel();
  toast('Кэш очищен');
});

els.btnBlocked.addEventListener('click', async () => {
  const blocked = Array.isArray(state.settings.blocked) ? state.settings.blocked.slice() : [];
  const who = (await promptDialog({
    title: 'Заблокировать пользователя',
    label: 'Ник (@username), пусто — разблокировать всех',
    value: blocked.join(', '),
    confirmLabel: 'Сохранить'
  }));
  if (who === null) return;
  const list = who.split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  await persistSettings({ blocked: list });
  syncSettingsUI();
  toast(list.length ? 'Список блокировок обновлён' : 'Никто не заблокирован');
});

/* ---------------------------- account password ---------------------------- */
// The password is optional. It only guards the key file on this device; the
// relay sees a verifier, never the password itself.
async function refreshPasswordUI() {
  try {
    const s = await api.status();
    const has = !!s.hasPassword;
    els.setPasswordSub.textContent = has ? i18n.t('Password set') : i18n.t('No password set');
    els.btnSetPassword.textContent = has ? i18n.t('Change password') : i18n.t('Set a password');
  } catch { /* leave the last known label */ }
}

els.btnSetPassword.addEventListener('click', () => {
  els.formPassword.hidden = false;
  els.btnSetPassword.hidden = true;
  showError(els.setPasswordError, null);
  els.setPasswordInput.focus();
});

els.btnPasswordCancel.addEventListener('click', () => {
  els.formPassword.hidden = true;
  els.btnSetPassword.hidden = false;
  els.setPasswordInput.value = '';
  els.setPasswordConfirm.value = '';
  showError(els.setPasswordError, null);
});

els.formPassword.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(els.setPasswordError, null);
  const password = els.setPasswordInput.value;
  if (password.length < 8) {
    return showError(els.setPasswordError, i18n.t('Password must be at least 8 characters'));
  }
  if (password !== els.setPasswordConfirm.value) {
    return showError(els.setPasswordError, i18n.t('Passwords do not match'));
  }
  try {
    await api.setPassword(password);
    els.setPasswordInput.value = '';
    els.setPasswordConfirm.value = '';
    els.formPassword.hidden = true;
    els.btnSetPassword.hidden = false;
    await refreshPasswordUI();
    toast(i18n.t('Password set'));
  } catch (err) {
    showError(els.setPasswordError, err.message || i18n.t('Something went wrong'));
  }
});
els.btnSettingsClose.addEventListener('click', () => { els.settingsBackdrop.hidden = true; });
els.settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.settingsBackdrop) els.settingsBackdrop.hidden = true;
});

els.btnOpenSaved.addEventListener('click', () => {
  els.settingsBackdrop.hidden = true;
  startChatWith(state.username);
});

els.btnApplyServer.addEventListener('click', async () => {
  const url = els.setServer.value.trim();
  els.serverUrl.value = url;
  try {
    await api.connect(url);
    toast('Server updated');
  } catch {
    toast('Could not reach server');
  }
});

els.btnLogout.addEventListener('click', async () => {
  els.settingsBackdrop.hidden = true;
  await api.logout();
  resetToAuth();
  toast('Вы вышли. Ключи остались на устройстве — можно войти снова.');
});

/* ------------------------------- confirm ------------------------------- */
let confirmResolve = null;
function confirmDialog({ title, text, confirmLabel, cancelLabel }) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.btnConfirmYes.textContent = confirmLabel || 'Confirm';
  els.btnConfirmNo.textContent = cancelLabel || 'Cancel';
  els.confirmBackdrop.hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function settleConfirm(value) {
  els.confirmBackdrop.hidden = true;
  if (confirmResolve) { confirmResolve(value); confirmResolve = null; }
}
els.btnConfirmYes.addEventListener('click', () => settleConfirm(true));
els.btnConfirmNo.addEventListener('click', () => settleConfirm(false));
els.confirmBackdrop.addEventListener('click', (e) => {
  if (e.target === els.confirmBackdrop) settleConfirm(false);
});

/* ------------------------------- prompt -------------------------------- */
let promptResolve = null;
function promptDialog({ title, label, value, confirmLabel }) {
  els.promptTitle.textContent = title || 'Enter a value';
  els.promptLabel.textContent = label || 'Value';
  els.promptInput.value = value || '';
  els.btnPromptOk.textContent = confirmLabel || 'Save';
  els.promptBackdrop.hidden = false;
  els.promptInput.focus();
  els.promptInput.select();
  return new Promise((resolve) => { promptResolve = resolve; });
}
function settlePrompt(value) {
  els.promptBackdrop.hidden = true;
  if (promptResolve) { promptResolve(value); promptResolve = null; }
}
els.btnPromptOk.addEventListener('click', () => settlePrompt(els.promptInput.value));
els.btnPromptCancel.addEventListener('click', () => settlePrompt(null));
els.promptBackdrop.addEventListener('click', (e) => {
  if (e.target === els.promptBackdrop) settlePrompt(null);
});
els.promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); settlePrompt(els.promptInput.value); }
  if (e.key === 'Escape') settlePrompt(null);
});

/* ------------------------------- status ------------------------------- */
function updateConnIndicators(online) {
  state.online = online;
  els.authConn.classList.toggle('on', online);
  els.authConn.classList.toggle('off', !online);
  els.setConnDot.classList.toggle('on', online);
  els.setConnDot.classList.toggle('off', !online);
  els.setConn.textContent = online ? 'Connected' : 'Offline';
  els.meState.textContent = online ? (state.unlocked ? 'online' : 'locked') : 'offline';
  const dot = document.querySelector('.me-status .dot');
  if (dot) dot.classList.toggle('on', online);
}

/* -------------------------------- streak -------------------------------- */
// The "огонёк": how many days in a row the account has sent something. The
// relay counts the days; the client only draws the flame. A streak is always at
// least one the moment it is shown, so the chip stays hidden until it has one.
function renderSelfStreak() {
  const s = state.streak;
  if (!s || !s.count) { els.meStreak.hidden = true; return; }
  els.meStreak.hidden = false;
  els.meStreakCount.textContent = String(s.count);
  els.meStreak.classList.toggle('on', !!s.active);
  els.meStreak.title = s.active
    ? `Огонёк: ${s.count} ${plural(s.count, 'день', 'дня', 'дней')} подряд`
    : `Огонёк: ${s.count} ${plural(s.count, 'день', 'дня', 'дней')}. Отправьте сообщение, чтобы продлить.`;
}

/** Paint the streak line of the open profile from the cached profile fields. */
function renderProfileStreak(username) {
  const p = state.profiles.get(username);
  const count = p && p.streak ? p.streak : 0;
  if (!count) { els.profileStreak.hidden = true; return; }
  els.profileStreak.hidden = false;
  const active = !!p.streakActive;
  const days = plural(count, 'день', 'дня', 'дней');
  els.profileStreakText.textContent = active
    ? `${count} ${days} подряд`
    : `${count} ${days} подряд · сегодня ещё нет`;
}

async function loadStreak() {
  try {
    state.streak = await api.streak();
  } catch { /* the chip simply stays hidden until the next fetch */ }
  renderSelfStreak();
}

/**
 * Sending today lights the flame without waiting for a round trip. The relay
 * reconciles the count on the next open; this only makes the send feel immediate.
 */
function noteLocalSend() {
  const s = state.streak;
  if (!s || s.active) return;
  state.streak = { count: (s.count || 0) + 1, active: true };
  renderSelfStreak();
}

async function refreshStatus() {
  const s = await api.status();
  state.username = s.username || state.username;
  state.unlocked = s.unlocked;
  if (s.profile) { state.profile = s.profile; state.profiles.set(s.profile.username, s.profile); }
  if (state.username) {
    els.setUsername.textContent = '@' + state.username;
    if (s.profile) { applySelfProfile(s.profile); syncPrivacyUI(s.profile); }
    else {
      els.meName.textContent = state.username;
      els.meAvatar.textContent = initial(state.username);
    }
  }
  els.setPubkey.textContent = s.publicKey || '—';
  updateConnIndicators(s.online);
}

/* -------------------------------- events -------------------------------- */
api.onEvent((evt) => {
  switch (evt.type) {
    case 'connection':
      updateConnIndicators(evt.state === 'online');
      if (evt.state === 'online' && state.unlocked) loadChats();
      break;

    case 'session':
      if (evt.state === 'unlocked') {
        state.unlocked = true;
        enterMain(evt.username);
      } else if (evt.state === 'locked') {
        state.username = evt.username;
        els.unlockUser.textContent = `Unlock your vault, ${evt.username}.`;
        showScreen('unlock');
      } else if (evt.state === 'signed-out') {
        showScreen('auth');
      }
      break;

    case 'profile':
      state.profiles.set(evt.username, evt.profile);
      if (evt.username === state.username) { applySelfProfile(evt.profile); syncPrivacyUI(evt.profile); }
      renderChatList();
      if (state.activePeer && peerUsername(state.activePeer) === evt.username) {
        els.peerName.textContent = displayNameFor(evt.username);
        paintBadge(els.peerBadge, evt.username);
        paintAvatar(els.peerAvatar, evt.username);
      }
      if (state.profileTarget === evt.username) showProfile(evt.username, { self: evt.username === state.username });
      break;

    case 'announcement':
      toast(`${evt.from}: ${evt.text}`, 6000, 'announce');
      break;

    case 'kicked':
      handleKicked(evt.reason);
      break;

    case 'key':
      if (evt.profile) state.profiles.set(evt.username, evt.profile);
      if (typeof evt.online === 'boolean') state.presence.set(evt.username, evt.online);
      updatePeerSub();
      break;

    case 'presence':
      state.presence.set(evt.username, evt.online);
      if (evt.online) state.lastSeen.delete(evt.username);
      else if (evt.lastSeen) state.lastSeen.set(evt.username, evt.lastSeen);
      updatePeerSub();
      if (state.profileTarget === evt.username) refreshProfilePresence(evt.username);
      break;

    case 'typing': {
      const peer = evt.from;
      const existing = state.typing.get(peer);
      if (existing) clearTimeout(existing);
      if (evt.state === 'start') {
        const t = setTimeout(() => { state.typing.delete(peer); updatePeerSub(); }, 4000);
        state.typing.set(peer, t);
      } else {
        state.typing.delete(peer);
      }
      updatePeerSub();
      break;
    }

    case 'message': {
      const key = chatKey(evt.from);
      const chat = ensureChat(key);
      const payload = gamePayloadOf({ text: evt.text });
      if (payload) {
        // A game position from a peer. Adopt it, flipping the seat so their
        // side becomes the far side on this device.
        applyPeerGame(chat, evt.from, payload);
        break;
      }
      const m = {
        id: evt.id, text: evt.text, ts: evt.ts, mine: false, from: evt.from,
        replyTo: evt.replyTo || null, reactions: [],
        kind: evt.kind || null, attachment: evt.attachment || null
      };
      if (m.replyTo) {
        const orig = findMessage(m.replyTo);
        if (orig) m.quote = { from: orig.mine ? state.username : evt.from, text: orig.text, mine: orig.mine };
      }
      chat.messages.push(m);
      chat.last = previewOf(m);
      chat.lastTs = evt.ts;
      if (state.activePeer === key) {
        // A single live message lands at the end, so append it directly and
        // fall back to a rebuild only when the list is filtered. A vote is not
        // a bubble of its own; it just re-tallies the poll it points at.
        if (pollVoteOf(m)) renderMessagesImmediate();
        else if (!appendMessageEl(m)) renderMessages();
        updatePinnedBar();
        api.markRead(peerUsername(key)).catch(() => {});
      } else {
        chat.unread += 1;
        if (!chat.muted) notifyNewMessage(evt.from, evt.text);
      }
      renderChatList();
      break;
    }

    case 'pinned': {
      const key = chatKey(evt.peer);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) m.pinned = evt.pinned;
      }
      if (state.activePeer === key) { renderMessages(); updatePinnedBar(); }
      break;
    }

    case 'edited': {
      const key = chatKey(evt.from === state.username ? (evt.peer || state.activePeer) : evt.from);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.text = evt.text; m.editedAt = evt.editedAt; }
        if (chat.lastTs && m && chat.messages.at(-1) === m) chat.last = evt.text;
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'deleted': {
      for (const [key, chat] of state.chats) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.deleted = true; m.text = ''; m.reactions = []; if (state.activePeer === key) renderMessages(); break; }
      }
      renderChatList();
      break;
    }

    case 'reactions':
      applyReactions(evt.id, evt.reactions);
      break;

    case 'queued':
      toast(`New encrypted message from ${evt.from}`);
      break;

    case 'group.message': {
      const key = groupKey(evt.groupId);
      const chat = ensureChat(key);
      const m = {
        id: evt.id, text: evt.text, ts: evt.ts, mine: evt.from === state.username, from: evt.from,
        replyTo: evt.replyTo || null, reactions: [],
        kind: evt.kind || null, attachment: evt.attachment || null
      };
      if (m.replyTo) {
        const orig = findMessage(m.replyTo);
        if (orig) m.quote = { from: orig.mine ? state.username : orig.from, text: orig.text, mine: orig.mine };
      }
      chat.messages.push(m);
      chat.last = previewOf(m);
      chat.lastTs = evt.ts;
      if (state.activePeer === key) {
        // A vote is not a bubble; it only re-tallies the poll card, so repaint
        // at once even in a background window.
        if (pollVoteOf(m)) renderMessagesImmediate();
        else renderMessages();
        api.markRead(peerUsername(key)).catch(() => {});
      } else {
        chat.unread += 1;
        if (!chat.muted) notifyNewMessage(evt.from, evt.text);
      }
      renderChatList();
      break;
    }

    case 'group.edited': {
      const key = groupKey(evt.groupId);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.text = evt.text; m.editedAt = evt.editedAt; }
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'group.deleted': {
      const key = groupKey(evt.groupId);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.deleted = true; m.text = ''; m.reactions = []; }
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'group.updated': {
      const g = evt.group;
      if (g) {
        state.groups.set(g.id, g);
        for (const mem of g.members) {
          if (mem.profile) state.profiles.set(mem.username, mem.profile);
        }
        ensureChat(groupKey(g.id));
      }
      if (evt.left === state.username) {
        // We were removed or left; drop the chat row.
        state.chats.delete(groupKey(g ? g.id : evt.groupId));
        if (state.activePeer && groupIdOf(state.activePeer) === (g ? g.id : evt.groupId)) {
          state.activePeer = null;
          els.chatView.hidden = true;
          els.chatBlank.hidden = false;
        }
      }
      updatePeerSub();
      renderChatList();
      break;
    }

    case 'group.queued':
      toast('New encrypted group message');
      break;

    case 'channel.message': {
      const key = channelKey(evt.channelId);
      const chat = ensureChat(key);
      const m = {
        id: evt.id, text: evt.text, ts: evt.ts, mine: evt.from === state.username, from: evt.from,
        replyTo: evt.replyTo || null, reactions: [],
        kind: evt.kind || null, attachment: evt.attachment || null
      };
      if (m.replyTo) {
        const orig = findMessage(m.replyTo);
        if (orig) m.quote = { from: orig.mine ? state.username : orig.from, text: orig.text, mine: orig.mine };
      }
      chat.messages.push(m);
      chat.last = previewOf(m);
      chat.lastTs = evt.ts;
      if (state.activePeer === key) {
        renderMessages();
        updateComposerForChannel(key);
      } else {
        chat.unread += 1;
        if (!chat.muted) notifyNewMessage(displayNameFor(key), evt.text);
      }
      renderChatList();
      break;
    }

    case 'channel.edited': {
      const key = channelKey(evt.channelId);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.text = evt.text; m.editedAt = evt.editedAt; }
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'channel.deletedMessage': {
      const key = channelKey(evt.channelId);
      const chat = state.chats.get(key);
      if (chat) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.deleted = true; m.text = ''; m.reactions = []; }
      }
      if (state.activePeer === key) renderMessages();
      renderChatList();
      break;
    }

    case 'channel.updated': {
      const c = evt.channel;
      if (c) {
        const prev = state.channels.get(c.id);
        // A non-owner update omits the subscriber list; keep the one we had.
        if (prev && prev.subscribers && !c.subscribers) c.subscribers = prev.subscribers;
        state.channels.set(c.id, c);
        if (c.ownerProfile) state.profiles.set(c.owner, c.ownerProfile);
      }
      if (state.activePeer && isChannelKey(state.activePeer) && channelIdOf(state.activePeer) === (c && c.id)) {
        paintBadge(els.peerBadge, state.activePeer);
        els.peerName.textContent = displayNameFor(state.activePeer);
        updatePeerSub();
      }
      // Keep an open settings sheet in step with a change made elsewhere.
      if (c && !els.chsetBackdrop.hidden && chsetChannelId === c.id) {
        els.chsetNameLabel.textContent = c.name || '—';
        els.chsetHandleLabel.textContent = c.handle ? '@' + c.handle : 'без @адреса';
        renderChannelSubs(c);
      }
      renderChatList();
      break;
    }

    case 'channel.deleted': {
      const key = channelKey(evt.channelId);
      state.channels.delete(evt.channelId);
      state.chats.delete(key);
      if (state.activePeer === key) {
        state.activePeer = null;
        els.chatView.hidden = true;
        els.chatBlank.hidden = false;
      }
      renderChatList();
      break;
    }

    case 'channel.queued':
      toast('New encrypted channel post');
      break;

    default:
      break;
  }
});

/* ============================ attachments ============================ */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fileToBase64Bytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsArrayBuffer(file);
  });
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      resolve(file || null);
    });
    input.click();
  });
}

async function attachFile(kind, file) {
  if (!file || !state.activePeer) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    toast(`Too large — the limit is ${humanSize(MAX_ATTACHMENT_BYTES)}`);
    return;
  }
  let bytes;
  try {
    bytes = await fileToBase64Bytes(file);
  } catch (err) {
    toast(err.message || 'Could not read the file');
    return;
  }
  await sendWithAttachment({
    kind, bytes,
    name: file.name || (kind === 'voice' ? 'voice-message' : 'file'),
    mime: file.type || 'application/octet-stream',
    duration: null,
    preview: kind === 'image' ? URL.createObjectURL(file) : null
  });
}

async function sendWithAttachment(att) {
  const key = state.activePeer;
  const chat = ensureChat(key);
  const replyTo = state.replyTo;
  const caption = els.composerInput.value.trim();
  els.composerInput.value = '';

  // A bot chat is local: keep the sticker on this device and let the bot answer
  // without a round trip through the relay.
  if (isBotKey(key)) {
    const ts = Date.now();
    chat.messages.push({
      id: 'bot-me-' + ts, text: caption, ts, mine: true, reactions: [],
      kind: att.kind,
      attachment: { kind: att.kind, name: att.name, mime: att.mime, size: att.bytes.length, duration: att.duration },
      previewUrl: att.preview || null
    });
    chat.last = att.kind === 'image' ? 'Фото' : att.name;
    chat.lastTs = ts;
    state.forceScrollBottom = true;
    renderMessages();
    renderChatList();
    noteLocalSend();
    if (botIdOf(key) === BOT_STICKERS) {
      setTimeout(() => pushBotMessage(key, 'Классный стикер! 😄'), 350);
    }
    return;
  }

  const optimistic = {
    id: 'tmp-' + Date.now(), text: caption, ts: Date.now(), mine: true,
    replyTo: replyTo ? replyTo.id : null,
    quote: replyTo ? { from: replyTo.from, text: replyTo.text, mine: replyTo.mine } : null,
    pending: true, reactions: [],
    kind: att.kind,
    attachment: { kind: att.kind, name: att.name, mime: att.mime, size: att.bytes.length, duration: att.duration },
    previewUrl: att.preview || null
  };
  chat.messages.push(optimistic);
  chat.last = att.kind === 'image' ? 'Photo' : (att.kind === 'voice' ? 'Voice message' : att.name);
  chat.lastTs = optimistic.ts;
  clearReply();
  renderMessages();
  renderChatList();

  try {
    const res = isGroupKey(key)
      ? await api.sendGroup({
          groupId: groupIdOf(key), text: caption, members: groupMemberNames(groupIdOf(key)),
          replyTo: replyTo ? replyTo.id : undefined,
          attachment: { kind: att.kind, bytes: att.bytes, name: att.name, mime: att.mime, duration: att.duration }
        })
      : isChannelKey(key)
        ? await api.sendChannelPost({
            channelId: channelIdOf(key), text: caption, members: channelSubNames(channelIdOf(key)),
            replyTo: replyTo ? replyTo.id : undefined,
            attachment: { kind: att.kind, bytes: att.bytes, name: att.name, mime: att.mime, duration: att.duration }
          })
        : await api.send({
            to: peerUsername(key), text: caption, replyTo: replyTo ? replyTo.id : undefined,
            attachment: { kind: att.kind, bytes: att.bytes, name: att.name, mime: att.mime, duration: att.duration }
          });
    optimistic.id = res.id;
    noteLocalSend();
    optimistic.pending = false;
    optimistic.attachment = res.attachment || optimistic.attachment;
    renderMessages();
    renderChatList();
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    renderMessages();
    toast(err.message || 'Could not send the attachment');
  }
}

/** Fetch an attachment's bytes for display, whether it is a DM or a group message. */
async function fetchAttachment(m) {
  if (isGroupKey(state.activePeer)) return api.openGroupAttachment({ id: m.id });
  if (isChannelKey(state.activePeer)) return api.openChannelAttachment({ id: m.id });
  const peer = m.mine ? peerUsername(state.activePeer) : peerUsername(chatKey(m.from));
  return api.openAttachment({ id: m.id, peer });
}

/** Render an image attachment, decrypting it lazily the first time it is shown. */
function renderImageAttachment(m, wrap) {
  const img = document.createElement('img');
  img.className = 'att-image loading';
  img.alt = m.attachment.name || 'image';

  const show = (src) => {
    img.src = src;
    img.classList.remove('loading');
    img.dataset.loaded = '1';
  };

  // Decrypt once and remember the result on the message, so a re-render (every
  // new message rebuilds the list) does not fetch and decrypt it again.
  const load = async () => {
    if (img.dataset.loaded || img.dataset.loading) return;
    img.dataset.loading = '1';
    try {
      const res = await fetchAttachment(m);
      m.dataUrl = res.dataUrl;
      show(res.dataUrl);
    } catch (err) {
      img.classList.remove('loading');
      toast(err.message || 'Could not open the image');
    } finally {
      delete img.dataset.loading;
    }
  };

  if (m.previewUrl) show(m.previewUrl);
  else if (m.dataUrl) show(m.dataUrl);
  else {
    // Fetch on sight rather than on click: an image that only appeared after a
    // click looked like it loaded "sometimes", and the click was easy to miss.
    img.addEventListener('click', load);
    load();
  }
  wrap.appendChild(img);
}

function renderFileAttachment(m, wrap, kind) {
  const box = document.createElement('div');
  box.className = kind === 'voice' ? 'att-voice' : 'att-file';
  const ico = icon(kind === 'voice' ? 'i-mic' : 'i-file');
  const sizeLabel = kind === 'voice' && m.attachment.duration
    ? `${m.attachment.duration}s`
    : humanSize(m.attachment.size);
  box.innerHTML = `
    <span class="att-ico">${ico}</span>
    <span class="att-meta">
      <span class="att-name">${escapeHtml(m.attachment.name || (kind === 'voice' ? 'Voice message' : 'File'))}</span>
      <span class="att-size">${escapeHtml(sizeLabel)}</span>
    </span>
    <button class="att-dl" type="button">Open</button>
  `;
  box.querySelector('.att-dl').addEventListener('click', async () => {
    try {
      const res = await fetchAttachment(m);
      const a = document.createElement('a');
      a.href = res.dataUrl;
      a.download = res.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast(err.message || 'Could not open the file');
    }
  });
  wrap.appendChild(box);
}

/* ============================== emoji ============================== */
const EMOJI_GROUPS = [
  { icon: '😀', label: 'Smileys', items: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤗','🤔','🤨','😐','😑','😶','😏','😒','🙄','😬','😴','😌','😔','😪','🤤','😷','🤒','🤕','🤢','🥶','🥵','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','💀','💩','🤡','👻','👽','🤖'] },
  { icon: '👍', label: 'Gestures', items: ['👍','👎','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','🙏','💪','🦾','✍️','💅','👏','🙌','👐','🤲','🤜','🤛','✊','👊'] },
  { icon: '❤️', label: 'Hearts', items: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💋','💌'] },
  { icon: '🔥', label: 'Symbols', items: ['🔥','✨','⭐','🌟','💫','⚡','💥','💯','✅','❌','❗','❓','⚠️','🎉','🎊','🎁','🏆','🥇','🎯','📌','📎','🔔','🔕','🔒','🔓','🕐','⏰','☀️','🌙','☁️','🌈','💧','❄️'] },
  { icon: '🍕', label: 'Food', items: ['🍕','🍔','🍟','🌭','🍿','🍩','🍪','🎂','🍰','🍫','🍬','🍭','🍎','🍌','🍇','🍓','🍉','🍊','🥑','🥕','🍞','🧀','🥚','🍗','🍖','🍜','🍚','🍣','🍤','☕','🍵','🧃','🥤','🍺','🍻','🥂'] },
  { icon: '⚽', label: 'Activity', items: ['⚽','🏀','🏈','⚾','🎾','🏐','🏓','🏸','🥊','🎯','🎮','🎲','🎸','🎹','🎺','🎻','🥁','🎤','🎧','🎬','📷','🚗','✈️','🚀','🚲','⛰️','🏝️','🌍','🗺️','🧭'] }
];

function buildEmojiPanel() {
  els.emojiTabs.innerHTML = '';
  els.emojiGrid.innerHTML = '';
  EMOJI_GROUPS.forEach((group, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'emoji-tab' + (i === 0 ? ' active' : '');
    tab.textContent = group.icon;
    tab.title = group.label;
    tab.addEventListener('click', () => {
      els.emojiTabs.querySelectorAll('.emoji-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderEmojiGrid(group);
    });
    els.emojiTabs.appendChild(tab);
  });
  renderEmojiGrid(EMOJI_GROUPS[0]);
}

function renderEmojiGrid(group) {
  els.emojiGrid.innerHTML = '';
  for (const emoji of group.items) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'emoji-cell';
    cell.textContent = emoji;
    cell.addEventListener('click', () => {
      const input = els.composerInput;
      const start = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(input.selectionEnd ?? start);
      input.selectionStart = input.selectionEnd = start + emoji.length;
      input.focus();
    });
    els.emojiGrid.appendChild(cell);
  }
}

els.btnEmoji.addEventListener('click', () => {
  els.emojiPanel.hidden = !els.emojiPanel.hidden;
  els.attachBackdrop.hidden = true;
});

/* ------------------------------ stickers ------------------------------ */
// Stickers are sent as small images: a 128px PNG rendered from an emoji, so the
// picture travels through the same encrypted attachment path as a photo. No new
// wire format is needed, and the relay still only ever sees ciphertext.

const STICKERS = [
  { name: 'wink', emoji: '😉', tint: '#FFD37A' },
  { name: 'heart', emoji: '❤️', tint: '#F2668A' },
  { name: 'laugh', emoji: '😂', tint: '#57E3B4' },
  { name: 'cool', emoji: '😎', tint: '#3BA8FF' },
  { name: 'cry', emoji: '😭', tint: '#8A6BFF' },
  { name: 'angry', emoji: '😡', tint: '#FF6B6B' },
  { name: 'party', emoji: '🥳', tint: '#B79BFF' },
  { name: 'fire', emoji: '🔥', tint: '#F0A93B' },
  { name: 'star', emoji: '⭐', tint: '#FFD37A' },
  { name: 'rocket', emoji: '🚀', tint: '#3BA8FF' },
  { name: 'ghost', emoji: '👻', tint: '#93A1B5' },
  { name: 'clap', emoji: '👏', tint: '#C6F07A' },
  { name: 'think', emoji: '🤔', tint: '#7BE8E8' },
  { name: 'sleep', emoji: '😴', tint: '#B79BFF' },
  { name: 'cat', emoji: '🐱', tint: '#FFB08A' },
  { name: 'cake', emoji: '🎂', tint: '#F2668A' }
];

/** Draw one sticker to a 128x128 PNG data URL. */
function renderStickerDataUrl(sticker) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, sticker.tint);
  grad.addColorStop(1, 'rgba(20, 25, 34, 0.85)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(6, 6, size - 12, size - 12, 26);
  } else {
    ctx.rect(6, 6, size - 12, size - 12);
  }
  ctx.fill();
  ctx.font = '64px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(sticker.emoji, size / 2, size / 2 + 4);
  return canvas.toDataURL('image/png');
}

function buildStickerPanel() {
  els.stickerGrid.innerHTML = '';
  for (const sticker of STICKERS) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'sticker-cell';
    cell.title = sticker.name;
    const img = document.createElement('img');
    img.src = renderStickerDataUrl(sticker);
    img.alt = sticker.name;
    cell.appendChild(img);
    cell.addEventListener('click', async () => {
      els.emojiPanel.hidden = true;
      const dataUrl = renderStickerDataUrl(sticker);
      const base64 = dataUrl.split(',')[1];
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await sendWithAttachment({
        kind: 'image', bytes,
        name: `${sticker.name}.png`, mime: 'image/png',
        duration: null, preview: dataUrl
      });
    });
    els.stickerGrid.appendChild(cell);
  }
}

function setPanelMode(mode) {
  els.panelSwitch.querySelectorAll('.panel-switch-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  els.emojiMode.hidden = mode !== 'emoji';
  els.stickerMode.hidden = mode !== 'stickers';
  els.gamesMode.hidden = mode !== 'games';
  if (mode === 'games') buildGamePanel();
}

els.panelSwitch.addEventListener('click', (e) => {
  const tab = e.target.closest('.panel-switch-tab');
  if (tab) setPanelMode(tab.dataset.mode);
});
els.btnAttach.addEventListener('click', () => {
  els.attachBackdrop.hidden = !els.attachBackdrop.hidden;
  els.emojiPanel.hidden = true;
});
els.attachBackdrop.addEventListener('click', (e) => {
  if (e.target === els.attachBackdrop) els.attachBackdrop.hidden = true;
});
els.attachMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-attach]');
  if (!btn) return;
  const kind = btn.dataset.attach;
  els.attachBackdrop.hidden = true;
  if (kind === 'gift') { openGifts(); return; }
  if (kind === 'poll') { openPollComposer(); return; }
  const file = await pickFile(kind === 'image' ? 'image/*' : undefined);
  if (file) await attachFile(kind === 'image' ? 'image' : 'file', file);
});

/* ---------------------------- voice notes ---------------------------- */
els.btnVoice.addEventListener('click', async () => {
  if (state.recording) {
    state.recording.recorder.stop();
    return;
  }
  if (!state.activePeer) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Voice recording is not available on this device');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone permission was denied');
    return;
  }
  const chunks = [];
  const recorder = new MediaRecorder(stream);
  const startedAt = Date.now();
  state.recording = { recorder, stream, startedAt };
  els.btnVoice.classList.add('recording');
  els.btnVoice.title = 'Stop recording';
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
  recorder.addEventListener('stop', async () => {
    stream.getTracks().forEach((t) => t.stop());
    els.btnVoice.classList.remove('recording');
    els.btnVoice.title = 'Voice message';
    state.recording = null;
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (!blob.size) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await sendWithAttachment({
      kind: 'voice', bytes, name: `voice-${seconds}s.webm`,
      mime: 'audio/webm', duration: seconds, preview: null
    });
  });
  recorder.start();
  toast('Recording… tap the microphone again to send');
});

/* =========================== in-chat search =========================== */
function openChatSearch() {
  els.chatSearchBar.hidden = false;
  els.chatSearchInput.focus();
  els.chatSearchInput.select();
}

function closeChatSearch() {
  els.chatSearchBar.hidden = true;
  els.chatSearchInput.value = '';
  els.chatSearchCount.textContent = '';
  state.searchQuery = '';
  state.searchHits = [];
  state.searchIndex = -1;
  if (state.activePeer) renderMessages();
}

async function runChatSearch(query) {
  state.searchQuery = query;
  state.searchHits = [];
  state.searchIndex = -1;
  if (!query) { els.chatSearchCount.textContent = ''; renderMessages(); return; }
  if (!state.activePeer) return;
  const chat = activeChat();
  const needle = query.toLowerCase();
  // Search what is already loaded; pull more history so older matches appear.
  if (chat && !chat.loaded) {
    try {
      const items = await api.history({ with: peerUsername(state.activePeer), limit: 300 });
      chat.messages = resolveQuotes(items);
      chat.loaded = true;
    } catch { /* keep what we have */ }
  }
  const hits = [];
  for (const m of (chat ? chat.messages : [])) {
    if (m.deleted) continue;
    const text = (m.text || '').toLowerCase();
    const name = m.attachment && m.attachment.name ? m.attachment.name.toLowerCase() : '';
    if (text.includes(needle) || name.includes(needle)) hits.push(m.id);
  }
  state.searchHits = hits;
  state.searchIndex = hits.length ? hits.length - 1 : -1;
  els.chatSearchCount.textContent = hits.length ? `${hits.length} found` : 'none';
  renderMessagesImmediate();
  if (hits.length) scrollToMessage(hits[state.searchIndex], { smooth: false });
}

let chatSearchTimer = null;
els.btnChatSearch.addEventListener('click', () => {
  if (els.chatSearchBar.hidden) openChatSearch(); else closeChatSearch();
});
els.btnChatSearchClose.addEventListener('click', closeChatSearch);
els.chatSearchInput.addEventListener('input', () => {
  clearTimeout(chatSearchTimer);
  const q = els.chatSearchInput.value.trim();
  chatSearchTimer = setTimeout(() => runChatSearch(q), 200);
});
els.chatSearchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !state.searchHits.length) return;
  e.preventDefault();
  state.searchIndex = (state.searchIndex - 1 + state.searchHits.length) % state.searchHits.length;
  renderMessagesImmediate();
  scrollToMessage(state.searchHits[state.searchIndex]);
});

/* ============================ pinned banner ============================ */
function updatePinnedBar() {
  const chat = activeChat();
  const pinned = chat ? chat.messages.filter((m) => m.pinned && !m.deleted) : [];
  if (!pinned.length) { els.pinnedBar.hidden = true; return; }
  const top = pinned[pinned.length - 1];
  els.pinnedTitle.textContent = top.mine
    ? 'Pinned message · you'
    : `Pinned message · ${displayNameFor(peerUsername(chatKey(top.from || state.username)))}`;
  els.pinnedText.textContent = top.attachment && !top.text
    ? (top.attachment.name || 'Attachment')
    : (top.text || 'Message');
  els.pinnedBar.hidden = false;
  els.pinnedBar.onclick = () => scrollToMessage(top.id);
}

els.btnPinnedUnpin.addEventListener('click', async (e) => {
  e.stopPropagation();
  const chat = activeChat();
  const pinned = chat ? chat.messages.filter((m) => m.pinned) : [];
  if (!pinned.length) return;
  const top = pinned[pinned.length - 1];
  try {
    await api.pinMessage({ id: top.id, pinned: false });
    top.pinned = false;
    updatePinnedBar();
    renderMessages();
    toast('Unpinned');
  } catch (err) {
    toast(err.message || 'Could not unpin');
  }
});

/* ============================ appearance ============================ */
const WALLPAPERS = ['none', 'dots', 'grid', 'sunset', 'mint'];

function applyTheme(theme) {
  state.settings.theme = theme;
  document.body.classList.toggle('theme-light', theme === 'light');
  els.setThemeSub.textContent = theme === 'light' ? 'Light' : 'Dark';
  els.btnThemeToggle.textContent = theme === 'light' ? 'Dark' : 'Light';
}

function applyWallpaper(wallpaper) {
  state.settings.wallpaper = wallpaper;
  for (const name of WALLPAPERS) {
    els.chatView.classList.toggle('wallpaper-' + name, name === wallpaper);
  }
  els.wallpaperPicker.querySelectorAll('.wallpaper-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.wallpaper === wallpaper);
  });
}

function buildWallpaperPicker() {
  els.wallpaperPicker.innerHTML = '';
  for (const name of WALLPAPERS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'wallpaper-swatch' + (name === state.settings.wallpaper ? ' active' : '');
    sw.dataset.wallpaper = name;
    sw.title = name;
    sw.innerHTML = `<span>${name}</span>`;
    sw.addEventListener('click', async () => {
      applyWallpaper(name);
      await persistSettings({ wallpaper: name });
    });
    els.wallpaperPicker.appendChild(sw);
  }
}

async function persistSettings(patch) {
  try {
    const saved = await api.saveSettings(patch);
    state.settings = { ...state.settings, ...saved };
  } catch { /* settings are cosmetic; keep the local value */ }
}

els.btnThemeToggle.addEventListener('click', async () => {
  const next = state.settings.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  await persistSettings({ theme: next });
});

/** Flip the theme from the drawer without opening Settings. */
async function toggleTheme() {
  const next = state.settings.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  await persistSettings({ theme: next });
  toast(next === 'light' ? 'Светлая тема' : 'Тёмная тема');
}

async function loadAppearance() {
  try {
    const s = await api.getSettings();
    if (s && typeof s === 'object') state.settings = { ...state.settings, ...s };
  } catch { /* defaults are fine */ }
  applyTheme(state.settings.theme === 'light' ? 'light' : 'dark');
  applyLanguage(state.settings.language);
  applyWallpaper(WALLPAPERS.includes(state.settings.wallpaper) ? state.settings.wallpaper : 'none');
  buildWallpaperPicker();
  document.documentElement.classList.toggle('reduce-motion', state.settings.reduceMotion === true);
}

/** Switch the interface language and re-translate everything on screen. */
function applyLanguage(next) {
  const lang = i18n.setLang(next || 'ru');
  state.settings.language = lang;
  document.documentElement.lang = lang;
  i18n.apply(document.body);
  if (els.setLanguage) els.setLanguage.value = lang;
  if (typeof refreshLocalizedText === 'function') refreshLocalizedText();
  return lang;
}

/* ============================ forward / select ============================ */
function otherChatKeys() {
  return Array.from(state.chats.keys()).filter((k) => k !== state.activePeer);
}

function openForward(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  const keys = otherChatKeys();
  els.forwardList.innerHTML = '';
  els.forwardEmpty.hidden = keys.length > 0;
  for (const key of sortedKeys(keys.slice())) {
    const peer = peerUsername(key);
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.innerHTML = `
      <div class="avatar small" data-color="${escapeHtml(avatarColorFor(peer))}">${avatarInnerHtml(peer)}</div>
      <div class="chat-item-body">
        <div class="chat-item-top"><span class="chat-item-name">${escapeHtml(key === SAVED ? 'Saved Messages' : displayNameFor(peer))}</span></div>
      </div>
    `;
    li.addEventListener('click', async () => {
      els.forwardBackdrop.hidden = true;
      await forwardTo(key, list);
    });
    els.forwardList.appendChild(li);
  }
  els.forwardBackdrop.hidden = false;
}

async function forwardTo(key, messages) {
  let sent = 0;
  for (const m of messages) {
    try {
      // Re-encrypt the bytes for the destination rather than reusing the old box.
      let bytes = null;
      if (m.kind && m.attachment) {
        const res = await openAttachmentBytes(m);
        bytes = await dataUrlToBytes(res.dataUrl);
      }
      if (isGroupKey(key)) {
        await api.sendGroup({
          groupId: groupIdOf(key), text: m.text || '', members: groupMemberNames(groupIdOf(key)),
          attachment: bytes ? { kind: m.kind, bytes, name: m.attachment.name, mime: m.attachment.mime, duration: m.attachment.duration } : undefined
        });
      } else if (isChannelKey(key)) {
        await api.sendChannelPost({
          channelId: channelIdOf(key), text: m.text || '', members: channelSubNames(channelIdOf(key)),
          attachment: bytes ? { kind: m.kind, bytes, name: m.attachment.name, mime: m.attachment.mime, duration: m.attachment.duration } : undefined
        });
      } else if (bytes) {
        await api.send({
          to: peerUsername(key), text: m.text || '',
          attachment: { kind: m.kind, bytes, name: m.attachment.name, mime: m.attachment.mime, duration: m.attachment.duration }
        });
      } else if (m.text) {
        await api.send({ to: peerUsername(key), text: m.text });
      }
      sent += 1;
      noteLocalSend();
    } catch (err) {
      toast(err.message || 'Could not forward');
      break;
    }
  }
  if (sent) toast(`Forwarded ${sent} message${sent > 1 ? 's' : ''}`);
  exitSelectMode();
}

/** Fetch the decrypted bytes of a message's attachment, whatever chat it is in. */
async function openAttachmentBytes(m) {
  // Forwarding always starts from the open chat, so its kind is authoritative
  // (a message "from" me would otherwise look like a Saved-Messages peer).
  const key = state.activePeer;
  if (isGroupKey(key)) return api.openGroupAttachment({ id: m.id });
  if (isChannelKey(key)) return api.openChannelAttachment({ id: m.id });
  return api.openAttachment({ id: m.id, peer: peerUsername(key) });
}

function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function enterSelectMode(firstMessage) {
  state.selecting = new Set(firstMessage ? [firstMessage.id] : []);
  els.selectBar.hidden = false;
  renderMessages();
}

function exitSelectMode() {
  state.selecting = null;
  els.selectBar.hidden = true;
  if (state.activePeer) renderMessages();
}

function toggleSelected(id) {
  if (!state.selecting) return;
  if (state.selecting.has(id)) state.selecting.delete(id); else state.selecting.add(id);
  els.selectCount.textContent = `${state.selecting.size} selected`;
  renderMessages();
}

function selectedMessages() {
  const chat = activeChat();
  if (!chat || !state.selecting) return [];
  return chat.messages.filter((m) => state.selecting.has(m.id));
}

els.btnSelectCancel.addEventListener('click', exitSelectMode);
els.btnSelectForward.addEventListener('click', () => {
  const chosen = selectedMessages();
  if (!chosen.length) return;
  openForward(chosen);
});
els.btnSelectDelete.addEventListener('click', async () => {
  const chosen = selectedMessages().filter((m) => m.mine);
  if (!chosen.length) { toast('You can only delete your own messages'); return; }
  const ok = await confirmDialog({
    title: `Delete ${chosen.length} message${chosen.length > 1 ? 's' : ''}?`,
    text: 'They will be removed for both you and the recipient.',
    confirmLabel: 'Delete'
  });
  if (!ok) return;
  for (const m of chosen) {
    try {
      if (isGroupKey(state.activePeer)) await api.deleteGroupMessage({ id: m.id });
      else if (isChannelKey(state.activePeer)) await api.deleteChannelMessage({ id: m.id });
      else await api.remove(m.id);
      applyDeleted(m.id);
    } catch { /* keep going */ }
  }
  exitSelectMode();
  toast('Deleted');
});

/* ------------------------------ shortcuts ------------------------------ */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.attachBackdrop.hidden) return void (els.attachBackdrop.hidden = true);
    if (!els.emojiPanel.hidden) return void (els.emojiPanel.hidden = true);
    if (!els.ctxBackdrop.hidden) return closeContextMenu();
    if (!els.confirmBackdrop.hidden) return settleConfirm(false);
    if (!els.forwardBackdrop.hidden) return void (els.forwardBackdrop.hidden = true);
    if (!els.profileBackdrop.hidden) return closeProfile();
    if (!els.chatmenuBackdrop.hidden) return void (els.chatmenuBackdrop.hidden = true);
    if (!els.settingsBackdrop.hidden) return void (els.settingsBackdrop.hidden = true);
    if (state.selecting) return exitSelectMode();
    if (!els.chatSearchBar.hidden) return closeChatSearch();
    if (state.editing) return clearEditing();
    if (state.replyTo) return clearReply();
  }
});

/* ============================== drawer ============================== */
function openDrawer() {
  els.drawer.hidden = false;
  els.drawerBackdrop.hidden = false;
  paintAvatar(els.drawerAvatar, state.username);
  els.drawerName.textContent = displayNameFor(state.username);
  els.drawerHandle.textContent = '@' + (state.username || '—');
  els.drawerAccountsCount.hidden = state.accounts.length <= 1;
  els.drawerAccountsCount.textContent = String(state.accounts.length);
  els.drawerVer.textContent = els.footVer ? els.footVer.textContent : 'v0.4.0';
}

function closeDrawer() {
  els.drawer.hidden = true;
  els.drawerBackdrop.hidden = true;
}

els.btnMenu.addEventListener('click', async () => {
  try { state.accounts = await api.listAccounts(); } catch { /* keep cached */ }
  openDrawer();
});
els.drawerBackdrop.addEventListener('click', closeDrawer);

els.drawer.addEventListener('click', (e) => {
  const item = e.target.closest('.drawer-item');
  if (!item) return;
  const action = item.dataset.drawer;
  closeDrawer();

  if (action === 'accounts') openAccounts();
  else if (action === 'my-profile') openMyProfile();
  else if (action === 'create') openCreateMenu();
  else if (action === 'channels') openDiscover();
  else if (action === 'contacts') openContacts();
  else if (action === 'bots') openBots();
  else if (action === 'saved') startChatWith(state.username);
  else if (action === 'folders') openFolders();
  else if (action === 'settings') els.btnSettings.click();
  else if (action === 'new-chat') { els.search.value = ''; els.btnSearchClear.hidden = true; els.search.focus(); }
  else if (action === 'archived') {
    els.sectionArchived.hidden = false;
    els.archivedList.hidden = false;
    els.sectionArchived.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else if (action === 'theme') {
    toggleTheme();
  }
});

/* --------------------------- create menu --------------------------- */
function openCreateMenu() {
  els.createBackdrop.hidden = false;
}

els.btnCreateClose.addEventListener('click', () => { els.createBackdrop.hidden = true; });
els.createBackdrop.addEventListener('click', (e) => {
  if (e.target === els.createBackdrop) els.createBackdrop.hidden = true;
});
els.createAccount.addEventListener('click', async () => {
  els.createBackdrop.hidden = true;
  await api.logout().catch(() => {});
  resetToAuth();
});
els.createGroup.addEventListener('click', () => {
  els.createBackdrop.hidden = true;
  openGroupModal();
});
els.createChannel.addEventListener('click', () => {
  els.createBackdrop.hidden = true;
  openChannelModal();
});

/* ---------------------------- accounts ---------------------------- */
async function openAccounts() {
  try { state.accounts = await api.listAccounts(); } catch { /* keep cached */ }
  renderAccounts();
  els.accountsBackdrop.hidden = false;
}

function renderAccounts() {
  els.accountsList.innerHTML = '';
  for (const acc of state.accounts) {
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.dataset.username = acc.username;
    row.innerHTML = `
      <span class="avatar tiny" data-color="${escapeHtml(avatarColorFor(acc.username))}">${avatarInnerHtml(acc.username)}</span>
      <span class="drawer-label">${escapeHtml(displayNameFor(acc.username))}</span>
      ${acc.active ? '<span class="drawer-badge">активный</span>' : ''}
      <button class="icon-btn" data-forget="${escapeHtml(acc.username)}" title="Убрать с устройства">${icon('i-close')}</button>
    `;
    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-forget]')) return;
      if (acc.active) { els.accountsBackdrop.hidden = true; return; }
      await switchToAccount(acc.username);
    });
    els.accountsList.appendChild(row);
  }
}

els.accountsList.addEventListener('click', async (e) => {
  const forget = e.target.closest('[data-forget]');
  if (!forget) return;
  const username = forget.dataset.forget;
  const ok = await confirmDialog({
    title: 'Убрать аккаунт?',
    text: `@${username} будет удалён с этого устройства. Ключи пропадут — сообщения нельзя будет прочитать без пароля на другом устройстве.`,
    confirmLabel: 'Убрать'
  });
  if (!ok) return;
  try {
    const res = await api.forgetAccount(username);
    state.accounts = await api.listAccounts();
    if (res.switched) {
      els.accountsBackdrop.hidden = true;
      await restartSession();
    } else {
      renderAccounts();
    }
    toast('Аккаунт удалён с устройства');
  } catch (err) {
    toast(err.message || 'Не удалось удалить аккаунт');
  }
});

els.btnAccountsAdd.addEventListener('click', async () => {
  els.accountsBackdrop.hidden = true;
  await api.logout().catch(() => {});
  resetToAuth();
  toast('Войдите или создайте аккаунт');
});

els.btnAccountsClose.addEventListener('click', () => { els.accountsBackdrop.hidden = true; });
els.accountsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.accountsBackdrop) els.accountsBackdrop.hidden = true;
});

/* -------------------------------- bots -------------------------------- */
function openBots() {
  els.botsList.innerHTML = '';
  for (const bot of BOTS.values()) {
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.dataset.bot = bot.id;
    row.innerHTML = `
      <span class="avatar tiny" data-color="${escapeHtml(bot.color)}">${icon('i-robot')}</span>
      <span class="drawer-label">${escapeHtml(bot.title)}<br><small class="drawer-sub">${escapeHtml(bot.subtitle)}</small></span>
    `;
    row.addEventListener('click', () => {
      els.botsBackdrop.hidden = true;
      openBotChat(bot.id);
    });
    els.botsList.appendChild(row);
  }
  els.botsBackdrop.hidden = false;
}

els.btnBotsClose.addEventListener('click', () => { els.botsBackdrop.hidden = true; });
els.botsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.botsBackdrop) els.botsBackdrop.hidden = true;
});

/* -------------------------------- gifts -------------------------------- */
// A gift is a small, fixed catalogue of emoji, sent as an ordinary encrypted
// message. The relay stores only the ciphertext, exactly like any other
// message, so the relay never learns that a gift was sent or which one.
const GIFTS = [
  { id: 'rose', emoji: '🌹', name: 'Роза', cost: 1 },
  { id: 'teddy', emoji: '🧸', name: 'Мишка', cost: 5 },
  { id: 'cake', emoji: '🎂', name: 'Торт', cost: 5 },
  { id: 'heart', emoji: '💝', name: 'Сердце', cost: 10 },
  { id: 'ring', emoji: '💍', name: 'Кольцо', cost: 25 },
  { id: 'trophy', emoji: '🏆', name: 'Кубок', cost: 25 },
  { id: 'diamond', emoji: '💎', name: 'Алмаз', cost: 50 },
  { id: 'rocket', emoji: '🚀', name: 'Ракета', cost: 50 },
  { id: 'crown', emoji: '👑', name: 'Корона', cost: 100 },
  { id: 'star', emoji: '🌟', name: 'Звезда', cost: 100 }
];

function giftById(id) { return GIFTS.find((g) => g.id === id) || null; }

/** A gift message carries this payload as its (encrypted) text. */
function giftPayloadOf(m) {
  if (!m || !m.text || m.text[0] !== '{') return null;
  try {
    const obj = JSON.parse(m.text);
    if (obj && typeof obj.gift === 'string') return obj;
  } catch { /* not a gift payload */ }
  return null;
}

function openGifts() {
  const key = state.activePeer;
  if (!key || isGroupKey(key) || isChannelKey(key) || isBotKey(key) || key === SAVED) {
    toast('Подарок можно отправить собеседнику в личном чате');
    return;
  }
  els.giftsNote.textContent = `Подарок для ${displayNameFor(key)}`;
  els.giftsGrid.innerHTML = '';
  for (const gift of GIFTS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gift-card';
    card.dataset.gift = gift.id;
    card.innerHTML = `<span class="gift-emoji">${gift.emoji}</span>
      <span class="gift-name">${escapeHtml(gift.name)}</span>
      <span class="gift-cost">${gift.cost} ⭐</span>`;
    card.addEventListener('click', async () => {
      els.giftsBackdrop.hidden = true;
      await sendGift(gift);
    });
    els.giftsGrid.appendChild(card);
  }
  els.giftsBackdrop.hidden = false;
}

async function sendGift(gift) {
  const key = state.activePeer;
  if (!key) return;
  const payload = JSON.stringify({ gift: gift.id, name: gift.name, emoji: gift.emoji, cost: gift.cost });
  const chat = ensureChat(key);
  const optimistic = {
    id: 'tmp-gift-' + Date.now(), text: payload, ts: Date.now(), mine: true,
    pending: true, reactions: []
  };
  chat.messages.push(optimistic);
  chat.last = `Подарок: ${gift.name}`;
  chat.lastTs = optimistic.ts;
  state.forceScrollBottom = true;
  renderMessages();
  renderChatList();
  try {
    const res = await api.send({ to: peerUsername(key), text: payload });
    optimistic.id = res.id;
    optimistic.pending = false;
    noteLocalSend();
    renderMessages();
    renderChatList();
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    renderMessages();
    toast(err.message || 'Не удалось отправить подарок');
  }
}

els.btnGiftsClose.addEventListener('click', () => { els.giftsBackdrop.hidden = true; });
els.giftsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.giftsBackdrop) els.giftsBackdrop.hidden = true;
});

/* -------------------------------- polls -------------------------------- */
// A poll is an ordinary encrypted message whose text is a small JSON document,
// and every vote is another one. The relay stores ciphertext only, so it never
// learns the question, the options, or who voted for what. The vote tally is
// computed on each device from the votes it can read.

function pollPayloadOf(m) {
  return m && POLLS ? POLLS.decode(m.text) : null;
}

function pollVoteOf(m) {
  return m && POLLS ? POLLS.decodeVote(m.text) : null;
}

/** The poll id is the id of the message that introduced it. */
function pollOfChat(chat, id) {
  if (!chat) return null;
  const m = chat.messages.find((x) => x.id === id);
  return m ? pollPayloadOf(m) : null;
}

/** Every vote cast in this chat for one poll, as { voter -> indices }. */
function pollVotes(chat, id) {
  const votes = {};
  for (const m of chat.messages) {
    const v = pollVoteOf(m);
    if (!v || v.pv !== id) continue;
    const voter = m.mine ? state.username : (m.from || chat.key);
    votes[voter] = v.i;
  }
  return votes;
}

function pollElement(m) {
  const poll = pollPayloadOf(m);
  const box = document.createElement('div');
  box.className = 'poll';
  box.dataset.poll = m.id;
  const chat = activeChat();
  const votes = pollVotes(chat, m.id);
  const tally = POLLS.tally(poll, votes);
  const me = m.mine ? state.username : (m.from || (chat && chat.key));
  const mine = votes[me] || [];
  const channel = state.activePeer && isChannelKey(state.activePeer)
    ? state.channels.get(channelIdOf(state.activePeer)) : null;
  const canVote = !poll.closed && chat && !chat.muted && !(channel && !channel.isOwner);

  box.innerHTML = `<div class="poll-head">
      <span class="poll-kind">${poll.m ? 'Опрос · несколько ответов' : 'Опрос'}</span>
      <span class="poll-question">${escapeHtml(poll.q)}</span>
    </div>`;

  poll.o.forEach((text, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'poll-option' + (mine.includes(i) ? ' chosen' : '');
    row.dataset.option = String(i);
    const rowTally = tally.rows[i] || { count: 0, share: 0 };
    const winner = tally.winner === i;
    row.innerHTML = `
      <span class="poll-bar"></span>
      <span class="poll-option-body">
        <span class="poll-check${poll.m ? ' multi' : ''}">${mine.includes(i) ? icon('i-check') : ''}</span>
        <span class="poll-option-text">${escapeHtml(text)}${winner ? ' ' + icon('i-star', 'poll-win') : ''}</span>
        <span class="poll-option-count">${rowTally.count}</span>
      </span>`;
    // The bar width is set through the CSSOM, not a style attribute: the page's
    // Content-Security-Policy is `style-src 'self'`, which forbids inline styles.
    row.querySelector('.poll-bar').style.width = `${(rowTally.share * 100).toFixed(1)}%`;
    if (canVote) row.addEventListener('click', () => votePoll(m.id, i));
    else row.disabled = true;
    box.appendChild(row);
  });

  const foot = document.createElement('div');
  foot.className = 'poll-foot';
  foot.textContent = `${tally.voters} ${plural(tally.voters, 'голос', 'голоса', 'голосов')}${poll.anon ? ' · анонимный' : ''}`;
  box.appendChild(foot);
  return box;
}

async function votePoll(pollId, optionIndex) {
  const key = state.activePeer;
  const chat = activeChat();
  if (!key || !chat || isChannelKey(key)) return;
  const poll = pollOfChat(chat, pollId);
  if (!poll || poll.closed) return;
  const me = state.username;
  const current = pollVotes(chat, pollId)[me] || [];
  const next = POLLS.toggle(poll, current, optionIndex);
  const text = POLLS.encodeVote(pollId, next);
  const optimistic = { id: 'tmp-vote-' + Date.now(), text, ts: Date.now(), mine: true, pending: true, reactions: [] };
  chat.messages.push(optimistic);
  renderMessagesImmediate();
  try {
    if (isGroupKey(key)) {
      const res = await api.sendGroup({ groupId: groupIdOf(key), text, members: groupMemberNames(groupIdOf(key)) });
      optimistic.id = res.id;
    } else {
      const res = await api.send({ to: peerUsername(key), text });
      optimistic.id = res.id;
    }
    optimistic.pending = false;
    noteLocalSend();
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    toast(err.message || 'Не удалось проголосовать');
  }
  renderMessagesImmediate();
  renderChatList();
}

function openPollComposer() {
  const key = state.activePeer;
  if (!key || isBotKey(key) || key === SAVED || isChannelKey(key)) {
    toast('Опрос можно отправить собеседнику или в группу');
    return;
  }
  els.pollQuestion.value = '';
  els.pollError.hidden = true;
  els.pollMultiple.checked = false;
  els.pollAnon.checked = true;
  els.pollOptions.innerHTML = '';
  addPollOptionInput();
  addPollOptionInput();
  els.pollBackdrop.hidden = false;
  els.pollQuestion.focus();
}

function addPollOptionInput() {
  if (els.pollOptions.children.length >= POLLS.MAX_OPTIONS) return;
  const row = document.createElement('div');
  row.className = 'poll-option-input';
  row.innerHTML = `<input type="text" class="contact-input" spellcheck="false" placeholder="Вариант" maxlength="${POLLS.MAX_OPTION}" />
    <button class="icon-btn" type="button" data-remove-option title="Удалить">${icon('i-close')}</button>`;
  row.querySelector('[data-remove-option]').addEventListener('click', () => {
    if (els.pollOptions.children.length > 2) row.remove();
  });
  els.pollOptions.appendChild(row);
}

async function createPoll() {
  const options = Array.from(els.pollOptions.querySelectorAll('input')).map((i) => i.value);
  const poll = POLLS.make(els.pollQuestion.value, options, {
    multiple: els.pollMultiple.checked,
    anon: els.pollAnon.checked
  });
  const check = POLLS.validate(poll);
  if (!check.ok) {
    els.pollError.textContent = check.error;
    els.pollError.hidden = false;
    return;
  }
  els.pollBackdrop.hidden = true;
  await sendPoll(poll);
}

async function sendPoll(poll) {
  const key = state.activePeer;
  if (!key) return;
  const text = POLLS.encode(poll);
  const chat = ensureChat(key);
  const optimistic = { id: 'tmp-poll-' + Date.now(), text, ts: Date.now(), mine: true, pending: true, reactions: [] };
  chat.messages.push(optimistic);
  chat.last = `Опрос: ${poll.q}`;
  chat.lastTs = optimistic.ts;
  state.forceScrollBottom = true;
  renderMessagesImmediate();
  renderChatList();
  try {
    if (isGroupKey(key)) {
      const res = await api.sendGroup({ groupId: groupIdOf(key), text, members: groupMemberNames(groupIdOf(key)) });
      optimistic.id = res.id;
    } else {
      const res = await api.send({ to: peerUsername(key), text });
      optimistic.id = res.id;
    }
    optimistic.pending = false;
    noteLocalSend();
  } catch (err) {
    optimistic.pending = false;
    optimistic.failed = true;
    toast(err.message || 'Не удалось отправить опрос');
  }
  renderMessagesImmediate();
  renderChatList();
}

els.btnPollAdd.addEventListener('click', addPollOptionInput);
els.btnPollCreate.addEventListener('click', createPoll);
els.btnPollClose.addEventListener('click', () => { els.pollBackdrop.hidden = true; });
els.pollBackdrop.addEventListener('click', (e) => {
  if (e.target === els.pollBackdrop) els.pollBackdrop.hidden = true;
});

/* ---------------------------- folders ("папки") ---------------------------- */

function openFolders() {
  state.folderEditing = null;
  els.folderEditor.hidden = true;
  els.folderError.hidden = true;
  renderFolderManager();
  els.folderBackdrop.hidden = false;
}

function renderFolderManager() {
  els.folderList.innerHTML = '';
  els.folderEmpty.hidden = state.folders.length > 0;
  for (const folder of state.folders) {
    const row = document.createElement('div');
    row.className = 'folder-row' + (folder.id === state.folderEditing ? ' active' : '');
    const kinds = FOLDERS.KINDS.filter((k) => folder.kinds[k]);
    const summary = [
      kinds.length ? `${kinds.length} тип(а)` : 'без типов',
      folder.unreadOnly ? 'только непрочитанные' : '',
      folder.include.length ? `+${folder.include.length}` : ''
    ].filter(Boolean).join(' · ');
    row.innerHTML = `
      <span class="folder-row-ico">${icon('i-folder')}</span>
      <span class="folder-row-body">
        <span class="folder-row-name">${escapeHtml(folder.name)}</span>
        <span class="folder-row-sub">${escapeHtml(summary)}</span>
      </span>`;
    row.addEventListener('click', () => openFolderEditor(folder.id));
    els.folderList.appendChild(row);
  }
}

function openFolderEditor(id) {
  state.folderEditing = id;
  const folder = state.folders.find((f) => f.id === id);
  els.folderEditor.hidden = false;
  els.folderError.hidden = true;
  els.btnFolderDelete.hidden = !folder;
  if (folder) {
    els.folderName.value = folder.name;
    els.folderUnread.checked = folder.unreadOnly;
    els.folderExclusive.checked = !!folder.exclusive;
    for (const box of els.folderKinds.querySelectorAll('input[data-kind]')) {
      box.checked = !!folder.kinds[box.dataset.kind];
    }
  } else {
    els.folderName.value = '';
    els.folderUnread.checked = false;
    els.folderExclusive.checked = false;
    for (const box of els.folderKinds.querySelectorAll('input[data-kind]')) {
      box.checked = box.dataset.kind === 'private';
    }
  }
  renderFolderManager();
  els.folderName.focus();
}

function readFolderForm() {
  const kinds = {};
  for (const box of els.folderKinds.querySelectorAll('input[data-kind]')) {
    kinds[box.dataset.kind] = box.checked;
  }
  const existing = state.folders.find((f) => f.id === state.folderEditing);
  return FOLDERS.normalize({
    id: existing ? existing.id : undefined,
    name: els.folderName.value,
    kinds,
    unreadOnly: els.folderUnread.checked,
    exclusive: els.folderExclusive.checked,
    include: existing ? existing.include : [],
    exclude: existing ? existing.exclude : []
  });
}

function saveFolder() {
  const folder = readFolderForm();
  if (!folder) {
    els.folderError.textContent = 'Введите название папки';
    els.folderError.hidden = false;
    return;
  }
  folder.exclusive = els.folderExclusive.checked;
  const index = state.folders.findIndex((f) => f.id === folder.id);
  if (index >= 0) state.folders[index] = folder;
  else {
    if (state.folders.length >= FOLDERS.MAX_FOLDERS) {
      els.folderError.textContent = `Не больше ${FOLDERS.MAX_FOLDERS} папок`;
      els.folderError.hidden = false;
      return;
    }
    state.folders.push(folder);
  }
  if (state.activeFolder !== 'all' && !state.folders.some((f) => f.id === state.activeFolder)) {
    state.activeFolder = 'all';
  }
  saveFolders();
  renderFolderManager();
  els.folderEditor.hidden = true;
  state.folderEditing = null;
  toast(`Папка «${folder.name}» сохранена`);
}

function deleteFolder() {
  const id = state.folderEditing;
  if (!id) return;
  state.folders = state.folders.filter((f) => f.id !== id);
  if (state.activeFolder === id) state.activeFolder = 'all';
  saveFolders();
  renderFolderManager();
  els.folderEditor.hidden = true;
  state.folderEditing = null;
  toast('Папка удалена');
}

els.btnFolderNew.addEventListener('click', () => openFolderEditor(null));
els.btnFolderSave.addEventListener('click', saveFolder);
els.btnFolderDelete.addEventListener('click', deleteFolder);
els.btnFolderClose.addEventListener('click', () => { els.folderBackdrop.hidden = true; });
els.folderBackdrop.addEventListener('click', (e) => {
  if (e.target === els.folderBackdrop) els.folderBackdrop.hidden = true;
});

async function switchToAccount(username) {
  try {
    const res = await api.switchAccount(username);
    state.accounts = await api.listAccounts();
    els.accountsBackdrop.hidden = true;
    await restartSession();
    toast(`Аккаунт @${res.username}`);
  } catch (err) {
    toast(err.message || 'Не удалось переключить аккаунт');
  }
}

/** Re-read the active identity and route to the right screen after a switch. */
async function restartSession() {
  state.chats.clear();
  state.profiles.clear();
  state.presence.clear();
  state.lastSeen.clear();
  state.groups.clear();
  state.channels.clear();
  state.drafts = {};
  state.folders = [];
  state.activeFolder = 'all';
  state.activePeer = null;
  els.chatList.innerHTML = '';
  els.archivedList.innerHTML = '';
  els.messages.innerHTML = '';
  els.chatView.hidden = true;
  els.chatBlank.hidden = false;
  const s = await api.status();
  if (s.username && !s.unlocked) {
    els.unlockUser.textContent = `Unlock your vault, ${s.username}.`;
    showScreen('unlock');
  } else if (s.username && s.unlocked) {
    await enterMain(s.username);
  } else {
    resetToAuth();
  }
}

/* ---------------------------- contacts ---------------------------- */
async function openContacts() {
  await loadContacts();
  renderContacts();
  els.contactError.hidden = true;
  els.contactsBackdrop.hidden = false;
}

function renderContacts() {
  els.contactsList.innerHTML = '';
  els.contactsEmpty.hidden = state.contacts.length > 0;
  for (const username of state.contacts) {
    const row = document.createElement('div');
    row.className = 'menu-item contact-row';
    row.innerHTML = `
      <span class="avatar tiny" data-color="${escapeHtml(avatarColorFor(username))}">${avatarInnerHtml(username)}</span>
      <span class="contact-name">${escapeHtml(displayNameFor(username))}</span>
      <span class="contact-handle">@${escapeHtml(username)}</span>
      <button class="icon-btn" data-remove="${escapeHtml(username)}" title="Удалить">${icon('i-close')}</button>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) return;
      els.contactsBackdrop.hidden = true;
      startChatWith(username);
    });
    els.contactsList.appendChild(row);
  }
}

els.contactsList.addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove]');
  if (!remove) return;
  state.contacts = state.contacts.filter((u) => u !== remove.dataset.remove);
  renderContacts();
  await saveContacts();
});

els.btnContactAdd.addEventListener('click', async () => {
  const username = bareUsername(els.contactInput.value);
  els.contactError.hidden = true;
  if (!USERNAME_RE.test(username)) {
    els.contactError.textContent = 'Ник: 3–32 символа a–z, 0–9, _';
    els.contactError.hidden = false;
    return;
  }
  if (username === state.username) {
    els.contactError.textContent = 'Это вы.';
    els.contactError.hidden = false;
    return;
  }
  if (state.contacts.includes(username)) {
    els.contactError.textContent = 'Уже в контактах.';
    els.contactError.hidden = false;
    return;
  }
  try {
    const key = await api.directory(username);
    if (key && key.profile) state.profiles.set(key.username, key.profile);
    state.contacts.push(username);
    state.contacts.sort();
    els.contactInput.value = '';
    renderContacts();
    await saveContacts();
    toast('Контакт добавлен');
  } catch (err) {
    els.contactError.textContent = err.message || 'Пользователь не найден';
    els.contactError.hidden = false;
  }
});

els.contactInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.btnContactAdd.click(); }
});

els.btnContactsClose.addEventListener('click', () => { els.contactsBackdrop.hidden = true; });
els.contactsBackdrop.addEventListener('click', (e) => {
  if (e.target === els.contactsBackdrop) els.contactsBackdrop.hidden = true;
});

/* --------------------------- create group --------------------------- */
function openGroupModal() {
  els.groupName.value = '';
  els.groupMembers.value = state.contacts.join(', ');
  els.groupError.hidden = true;
  els.groupBackdrop.hidden = false;
  els.groupName.focus();
}

els.btnGroupClose.addEventListener('click', () => { els.groupBackdrop.hidden = true; });
els.groupBackdrop.addEventListener('click', (e) => {
  if (e.target === els.groupBackdrop) els.groupBackdrop.hidden = true;
});

els.btnGroupCreate.addEventListener('click', async () => {
  const name = els.groupName.value.trim();
  const members = els.groupMembers.value
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  els.groupError.hidden = true;
  if (!name) {
    els.groupError.textContent = 'Введите название группы';
    els.groupError.hidden = false;
    return;
  }
  try {
    const group = await api.createGroup({ name, members });
    state.groups.set(group.id, group);
    for (const m of group.members) {
      if (m.profile) state.profiles.set(m.username, m.profile);
    }
    els.groupBackdrop.hidden = true;
    ensureChat(groupKey(group.id));
    renderChatList();
    openChat(groupKey(group.id));
    toast('Группа создана');
  } catch (err) {
    els.groupError.textContent = err.message || 'Не удалось создать группу';
    els.groupError.hidden = false;
  }
});

/* --------------------------- create channel --------------------------- */
function openChannelModal() {
  els.channelName.value = '';
  els.channelHandle.value = '';
  els.channelDesc.value = '';
  els.channelError.hidden = true;
  els.channelBackdrop.hidden = false;
  els.channelName.focus();
}

els.btnChannelClose.addEventListener('click', () => { els.channelBackdrop.hidden = true; });
els.channelBackdrop.addEventListener('click', (e) => {
  if (e.target === els.channelBackdrop) els.channelBackdrop.hidden = true;
});

els.btnChannelCreate.addEventListener('click', async () => {
  const name = els.channelName.value.trim();
  const description = els.channelDesc.value.trim();
  const handle = bareUsername(els.channelHandle.value) || undefined;
  els.channelError.hidden = true;
  if (!name) {
    els.channelError.textContent = 'Введите название канала';
    els.channelError.hidden = false;
    return;
  }
  if (handle && !USERNAME_RE.test(handle)) {
    els.channelError.textContent = '@адрес: 3–32 символа a–z, 0–9, _';
    els.channelError.hidden = false;
    return;
  }
  try {
    const channel = await api.createChannel({ name, description, handle });
    state.channels.set(channel.id, channel);
    els.channelBackdrop.hidden = true;
    ensureChat(channelKey(channel.id));
    renderChatList();
    openChat(channelKey(channel.id));
    toast(channel.handle ? `Канал создан: @${channel.handle}` : 'Канал создан');
  } catch (err) {
    els.channelError.textContent = err.message || 'Не удалось создать канал';
    els.channelError.hidden = false;
  }
});

/* -------------------------- channel settings -------------------------- */
let chsetChannelId = null;

function openChannelSettings(channelId) {
  const c = state.channels.get(channelId);
  if (!c) return;
  chsetChannelId = channelId;
  els.chsetError.hidden = true;
  els.chsetName.value = c.name || '';
  els.chsetHandle.value = c.handle ? '@' + c.handle : '';
  els.chsetDesc.value = c.description || '';
  els.chsetNameLabel.textContent = c.name || '—';
  els.chsetHandleLabel.textContent = c.handle ? '@' + c.handle : 'без @адреса';
  els.chsetAvatar.dataset.color = 'cyan';
  els.chsetAvatar.innerHTML = icon('i-globe');
  renderChannelSubs(c);
  els.chsetBackdrop.hidden = false;
  els.chsetName.focus();
}

function renderChannelSubs(c) {
  const subs = c.subscribers || [];
  els.chsetSubs.innerHTML = '';
  if (!subs.length) {
    els.chsetSubs.innerHTML = '<span class="panel-empty">Список недоступен</span>';
    return;
  }
  for (const name of subs) {
    const chip = document.createElement('span');
    chip.className = 'chset-sub';
    const isOwner = name === c.owner;
    chip.innerHTML = `
      <span class="avatar" data-color="${escapeHtml(avatarColorFor(name))}">${escapeHtml(initial(displayNameFor(name)))}</span>
      <span class="${isOwner ? 'chset-sub-owner' : ''}">${escapeHtml(atUsername(name))}${isOwner ? ' · владелец' : ''}</span>
    `;
    els.chsetSubs.appendChild(chip);
  }
}

els.btnChsetClose.addEventListener('click', () => { els.chsetBackdrop.hidden = true; });
els.chsetBackdrop.addEventListener('click', (e) => {
  if (e.target === els.chsetBackdrop) els.chsetBackdrop.hidden = true;
});

els.btnChsetSave.addEventListener('click', async () => {
  const c = state.channels.get(chsetChannelId);
  if (!c) return;
  const name = els.chsetName.value.trim();
  const handle = bareUsername(els.chsetHandle.value);
  const description = els.chsetDesc.value.trim();
  els.chsetError.hidden = true;
  if (!name) {
    els.chsetError.textContent = 'Введите название канала';
    els.chsetError.hidden = false;
    return;
  }
  if (!handle || !USERNAME_RE.test(handle)) {
    els.chsetError.textContent = '@адрес: 3–32 символа a–z, 0–9, _';
    els.chsetError.hidden = false;
    return;
  }
  els.btnChsetSave.disabled = true;
  try {
    const updated = await api.editChannel({ channelId: c.id, name, description, handle });
    state.channels.set(updated.id, updated);
    if (updated.ownerProfile) state.profiles.set(updated.owner, updated.ownerProfile);
    els.chsetNameLabel.textContent = updated.name;
    els.chsetHandleLabel.textContent = updated.handle ? '@' + updated.handle : 'без @адреса';
    els.chsetBackdrop.hidden = true;
    renderChatList();
    if (state.activePeer === channelKey(updated.id)) {
      els.peerName.textContent = displayNameFor(state.activePeer);
      updatePeerSub();
    }
    toast('Канал обновлён');
  } catch (err) {
    els.chsetError.textContent = err.message || 'Не удалось сохранить';
    els.chsetError.hidden = false;
  } finally {
    els.btnChsetSave.disabled = false;
  }
});

els.btnChsetDelete.addEventListener('click', async () => {
  const c = state.channels.get(chsetChannelId);
  if (!c) return;
  const ok = await confirmDialog({
    title: 'Удалить канал?',
    text: `Канал «${c.name}» будет удалён для всех подписчиков.`,
    confirmLabel: 'Удалить'
  });
  if (!ok) return;
  try {
    await api.deleteChannel({ channelId: c.id });
    els.chsetBackdrop.hidden = true;
    toast('Канал удалён');
  } catch (err) {
    els.chsetError.textContent = err.message || 'Не удалось удалить';
    els.chsetError.hidden = false;
  }
});

/* -------------------------- discover channels -------------------------- */
let discoverItems = [];

async function openDiscover() {
  els.discoverSearch.value = '';
  els.discoverBackdrop.hidden = false;
  els.discoverList.innerHTML = '<p class="panel-empty">Загрузка…</p>';
  try {
    discoverItems = await api.discoverChannels();
  } catch (err) {
    discoverItems = [];
    els.discoverList.innerHTML = `<p class="panel-empty">${escapeHtml(err.message || 'Не удалось загрузить')}</p>`;
    return;
  }
  renderDiscover();
}

function renderDiscover() {
  const query = (els.discoverSearch.value || '').trim().toLowerCase();
  const items = discoverItems.filter((c) => {
    if (!query) return true;
    const name = (c.name || '').toLowerCase();
    const handle = (c.handle || '').toLowerCase();
    return name.includes(query) || handle.includes(bareUsername(query));
  });
  els.discoverList.innerHTML = '';
  els.discoverEmpty.hidden = items.length > 0;
  if (!items.length) {
    els.discoverEmpty.textContent = query ? 'Ничего не найдено.' : 'Каналов пока нет. Создайте первый.';
    return;
  }
  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'menu-item contact-row';
    const tick = c.verified
      ? `<span class="verified-badge verified-badge-sm" title="Проверенный канал">${icon('i-check')}</span>`
      : '';
    const label = c.subscribed
      ? (c.isOwner ? 'ваш канал' : 'вы подписаны')
      : `${c.subs} ${plural(c.subs, 'подписчик', 'подписчика', 'подписчиков')}`;
    row.innerHTML = `
      <span class="avatar tiny" data-color="cyan">${icon('i-globe')}</span>
      <span class="contact-name">${escapeHtml(c.name)}${tick}</span>
      <span class="contact-handle">${c.handle ? '@' + escapeHtml(c.handle) + ' · ' : ''}${escapeHtml(label)}</span>
      <button class="btn-secondary btn-compact" data-open="${c.id}">${c.subscribed ? 'Открыть' : 'Подписаться'}</button>
    `;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open]');
      if (!btn) return;
      els.discoverBackdrop.hidden = true;
      if (c.subscribed) openChat(channelKey(c.id));
      else subscribeToChannel(c.id);
    });
    els.discoverList.appendChild(row);
  }
}

async function subscribeToChannel(channelId) {
  try {
    const channel = await api.joinChannel({ channelId });
    state.channels.set(channel.id, channel);
    if (channel.ownerProfile) state.profiles.set(channel.owner, channel.ownerProfile);
    ensureChat(channelKey(channel.id));
    renderChatList();
    openChat(channelKey(channel.id));
    toast('Вы подписались');
  } catch (err) {
    toast(err.message || 'Не удалось подписаться');
  }
}

els.discoverSearch.addEventListener('input', renderDiscover);
els.btnDiscoverClose.addEventListener('click', () => { els.discoverBackdrop.hidden = true; });
els.discoverBackdrop.addEventListener('click', (e) => {
  if (e.target === els.discoverBackdrop) els.discoverBackdrop.hidden = true;
});
els.btnDiscoverCreate.addEventListener('click', () => {
  els.discoverBackdrop.hidden = true;
  openChannelModal();
});

/* --------------------------------- boot --------------------------------- */
(async function boot() {
  showAuthHome();
  buildEmojiPanel();
  buildStickerPanel();
  loadAppearance();
  // Wait for the connection (and the session resume it triggers) before reading
  // status, or a returning device is read as signed out and lands on the sign-in
  // screen for a moment. A failure just falls through to the auth screen.
  await api.connect().catch(() => {});
  const s = await api.status();
  if (s.serverUrl) {
    els.serverUrl.value = s.serverUrl;
    els.setServer.value = s.serverUrl;
  }
  updateConnIndicators(s.online);
  if (s.username && !s.unlocked) {
    els.unlockUser.textContent = `Unlock your vault, ${s.username}.`;
    showScreen('unlock');
  } else if (s.username && s.unlocked) {
    enterMain(s.username);
  } else {
    showScreen('auth');
  }
})();
