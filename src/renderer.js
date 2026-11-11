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
const CHATSEARCH = (typeof window !== 'undefined' && window.SleePhyChatSearch) || null;
const SEARCH = (typeof window !== 'undefined' && window.SleePhyGlobalSearch) || null;
const CALLS = (typeof window !== 'undefined' && window.SleePhyCalls) || null;
const FM = (typeof window !== 'undefined' && window.SleePhyFM) || null;
const MONEY = (typeof window !== 'undefined' && window.SleePhyMoney) || null;
const STREAK = (typeof window !== 'undefined' && window.SleePhyStreak) || null;
const STORIES = (typeof window !== 'undefined' && window.SleePhyStories) || null;

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

/* ---------------------------- hidden bots ---------------------------- */
// A hidden bot has no chat of its own: you summon it by mentioning it in an
// ordinary conversation, e.g. `@minigames`. The mention is handled on this
// device and never sent, so the peer sees nothing until a real invitation
// follows, and the relay never learns a bot was used. This keeps the bot
// invisible in the chat list while still living inside the chat.
//
//   @minigames            offer the games, then invite the peer to one
//   @minigames шахматы    invite the peer straight to that game
//
// The match is anchored: only a message that *is* the mention (optionally with
// an argument) is intercepted, so "спасибо @minigames" is sent as normal text.

/** Parse a whole message that is a single `@name` with optional arguments. */
function parseBotMention(text) {
  const m = /^@([a-z0-9_]{3,32})(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

const HIDDEN_BOTS = new Map([
  ['minigames', {
    id: 'minigames',
    title: 'Мини-игры',
    icon: 'i-robot',
    /**
     * Offer the games in the open chat, or jump straight to one named in the
     * arguments. Either way the invitation that follows is a normal encrypted
     * message, so the peer's device adopts the board the moment it arrives.
     */
    run(key, args) {
      const peer = peerUsername(key);
      const wanted = args && GAMES
        ? GAMES.GAMES.find((g) => g.id === args.toLowerCase() || g.name.toLowerCase() === args.toLowerCase())
        : null;
      postBotNote(key, this.id, wanted
        ? `Приглашаю ${displayNameFor(peer)} в игру «${wanted.name}»…`
        : `Выберите игру — приглашу ${displayNameFor(peer)} сыграть вместе.`);
      if (wanted) startGameWithPeer(wanted.id);
      else openGamesPanel();
    }
  }]
]);

/** Run a hidden bot named by a mention. Returns true when the text was consumed. */
function runHiddenBotMention(key, text) {
  const hit = parseBotMention(text);
  if (!hit || !HIDDEN_BOTS.has(hit.name)) return false;
  if (isMultiKey(key) || key === SAVED || isBotKey(key)) {
    toast(`@${hit.name} работает в личном чате`);
    return true;
  }
  HIDDEN_BOTS.get(hit.name).run(key, hit.args);
  return true;
}

/**
 * Leave a short, local note from a hidden bot in the chat. It is a marker, not
 * a message: it is never sent, never a preview and never unread, and the relay
 * has no idea it exists. One note per bot per chat, replaced on each mention.
 */
function postBotNote(key, botId, text) {
  const chat = ensureChat(key);
  const id = `bot-note-${botId}`;
  const note = { id, kind: 'system:bot', text, ts: Date.now(), mine: false, local: true, reactions: [] };
  const at = chat.messages.findIndex((m) => m.id === id);
  if (at >= 0) chat.messages[at] = note;
  else chat.messages.push(note);
  if (state.activePeer === key) renderMessages();
  renderChatList();
}

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
  chat.gameMinimized = false;
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
  chat.gameMinimized = false;
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
  // A fresh position from the peer un-collapses our board, so a move is never
  // hidden behind a bar the local player left collapsed.
  chat.gameMinimized = false;
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

/** The "match over" notice a peer sends when they dismiss the board. */
function gameEndOf(m) {
  if (!m || !m.text || m.text[0] !== '{') return false;
  try {
    const obj = JSON.parse(m.text);
    return !!(obj && obj.g === 'end' && obj.end);
  } catch { return false; }
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
  // The board is pinned under the transcript, so it needs a way out: collapse it
  // to a thin bar (messages then flow normally) without ending the match.
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn game-board-close';
  close.title = 'Свернуть игру';
  close.innerHTML = icon('i-close');
  close.addEventListener('click', () => minimizeGame());
  head.appendChild(close);
  wrap.appendChild(head);

  const canPlay = game.status === 'play' && gameIsMyTurn(game);
  const body = game.id === 'tictactoe' ? tttBoard(game, canPlay)
    : game.id === 'checkers' ? draughtsBoard(game, canPlay)
      : game.id === 'chess' ? chessBoard(game, canPlay)
        : battleshipBoards(game, canPlay);
  wrap.appendChild(body);

  const res = g.result(game.state);
  if (game.status !== 'play' || res) {
    const actions = document.createElement('div');
    actions.className = 'game-board-actions';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn-secondary btn-compact';
    again.textContent = 'Играть снова';
    again.addEventListener('click', () => restartGame(game));
    const end = document.createElement('button');
    end.type = 'button';
    end.className = 'btn-ghost btn-compact';
    end.textContent = 'Завершить';
    end.addEventListener('click', () => endGame(activeChat()));
    actions.append(again, end);
    wrap.appendChild(actions);
  }
  return wrap;
}

/** Collapse the board of the open chat to a thin bar; the match keeps going. */
function minimizeGame() {
  const chat = activeChat();
  if (!chat || !chat.game) return;
  chat.gameMinimized = true;
  renderMessagesImmediate();
}

/** Expand the collapsed board again. */
function expandGame() {
  const chat = activeChat();
  if (!chat || !chat.game) return;
  chat.gameMinimized = false;
  renderMessagesImmediate();
}

/**
 * Drop the game from the open chat. The board disappears for good — the way out
 * the user asked for — and, in a match with a real person, the peer is told so
 * their board disappears too. The notice is an ordinary encrypted message, so
 * the relay stays blind. A bot game is local and needs no notice.
 */
async function endGame(chat) {
  if (!chat || !chat.game) return;
  const opponent = chat.game.opponent;
  chat.game = null;
  chat.gameMinimized = false;
  renderMessagesImmediate();
  renderChatList();
  if (opponent && opponent !== 'bot') {
    try { await api.send({ to: peerUsername(chat.key), text: JSON.stringify({ g: 'end', end: true }) }); }
    catch { /* best effort: the local board is already gone */ }
  }
}

/** A peer ended the match, so clear our board too. */
function endPeerGame(chat) {
  if (!chat || !chat.game) return;
  chat.game = null;
  chat.gameMinimized = false;
  if (state.activePeer === chat.key) renderMessagesImmediate();
  renderChatList();
}

/** The thin bar the collapsed board becomes, pinned where the board was. */
function gameMinBar(chat) {
  const g = GAMES && GAMES.byId(chat.game.id);
  const el = document.createElement('div');
  el.className = 'msg game-msg game-min';
  const bar = document.createElement('div');
  bar.className = 'game-min-bar';
  bar.innerHTML = `<span class="game-min-ico">${icon(GAME_ICONS[chat.game.id] || 'i-dice')}</span>
    <span class="game-min-name">${escapeHtml(g ? g.name : 'Игра')}</span>
    <span class="game-min-status">${escapeHtml(gameStatusText(chat.game))}</span>`;
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'btn-secondary btn-compact';
  expand.textContent = 'Развернуть';
  expand.addEventListener('click', () => expandGame());
  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'btn-ghost btn-compact';
  end.textContent = 'Завершить';
  end.addEventListener('click', () => endGame(chat));
  bar.append(expand, end);
  el.appendChild(bar);
  return el;
}

function restartGame(game) {
  const g = GAMES.byId(game.id);
  let st = g.create();
  if (game.id === 'battleship') st = GAMES.setFleet(st, game.seat);
  game.state = st;
  game.status = 'play';
  game.lastMove = null;
  const chat = activeChat();
  if (chat) chat.gameMinimized = false;
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
  peerStreak: $('peer-streak'),
  peerStreakCount: $('peer-streak-count'),
  search: $('search'),
  btnSearchClear: $('btn-search-clear'),
  searchPanel: $('search-panel'),
  searchResults: $('search-results'),
  searchEmpty: $('search-empty'),
  searchMessagesWrap: $('search-messages-wrap'),
  searchMessages: $('search-messages'),
  searchMessagesEmpty: $('search-messages-empty'),
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
  // Calls
  btnCallAudio: $('btn-call-audio'),
  btnCallVideo: $('btn-call-video'),
  callOverlay: $('call-overlay'),
  callVideos: $('call-videos'),
  callAvatar: $('call-avatar'),
  callTitle: $('call-title'),
  callSub: $('call-sub'),
  callTimer: $('call-timer'),
  btnCallMic: $('btn-call-mic'),
  btnCallCam: $('btn-call-cam'),
  btnCallScreen: $('btn-call-screen'),
  btnCallEnd: $('btn-call-end'),
  callRing: $('call-ring'),
  ringAvatar: $('ring-avatar'),
  ringTitle: $('ring-title'),
  ringSub: $('ring-sub'),
  btnRingAccept: $('btn-ring-accept'),
  btnRingDecline: $('btn-ring-decline'),
  // Бурмалда FM
  fmOverlay: $('fm-overlay'),
  fmTagline: $('fm-tagline'),
  fmArt: $('fm-art'),
  fmNowTitle: $('fm-now-title'),
  fmNowSub: $('fm-now-sub'),
  fmTime: $('fm-time'),
  fmDur: $('fm-dur'),
  fmSeek: $('fm-seek'),
  fmList: $('fm-list'),
  fmListCount: $('fm-list-count'),
  fmEmpty: $('fm-empty'),
  btnFmClose: $('btn-fm-close'),
  btnFmPlay: $('btn-fm-play'),
  btnFmPrev: $('btn-fm-prev'),
  btnFmNext: $('btn-fm-next'),
  btnFmShuffle: $('btn-fm-shuffle'),
  btnFmRepeat: $('btn-fm-repeat'),
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
  // Premium and Rockets.
  premiumBadge: $('premium-badge'),
  premiumSub: $('premium-sub'),
  premiumStatus: $('premium-status'),
  premiumPrice: $('premium-price'),
  premiumCta: $('premium-cta'),
  premiumNote: $('premium-note'),
  btnBuyPremium: $('btn-buy-premium'),
  rocketsBalance: $('rockets-balance'),
  rocketBundles: $('rocket-bundles'),
  rocketsNote: $('rockets-note'),
  storiesBar: $('stories-bar'),
  storyAdd: $('btn-story-add'),
  storyAddAvatar: $('story-add-avatar'),
  storyRingList: $('story-ring-list'),
  storyBackdrop: $('story-backdrop'),
  storyPreview: $('story-preview'),
  storyPreviewText: $('story-preview-text'),
  storyCaption: $('story-caption'),
  storyBgRow: $('story-bg-row'),
  storyTtl: $('story-ttl'),
  storyAudienceNote: $('story-audience-note'),
  storyError: $('story-error'),
  btnStoryClose: $('btn-story-close'),
  btnStoryPhoto: $('btn-story-photo'),
  btnStoryPublish: $('btn-story-publish'),
  storyViewer: $('story-viewer'),
  storyProgress: $('story-progress'),
  storyViewerAvatar: $('story-viewer-avatar'),
  storyViewerName: $('story-viewer-name'),
  storyViewerTime: $('story-viewer-time'),
  storyViewerCard: $('story-viewer-card'),
  storyViewerText: $('story-viewer-text'),
  storyViewerImage: $('story-viewer-image'),
  storyViewerViews: $('story-viewer-views'),
  btnStoryViewerClose: $('btn-story-viewer-close'),
  btnStoryDelete: $('btn-story-delete'),
  btnStoryPrev: $('btn-story-prev'),
  btnStoryNext: $('btn-story-next'),
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
  peerTtl: $('peer-ttl'),
  peerTtlLabel: $('peer-ttl-label'),
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
  profileSafety: $('profile-safety'),
  profileSafetyNumber: $('profile-safety-number'),
  btnSafetyCopy: $('btn-safety-copy'),
  btnSafetyMark: $('btn-safety-mark'),
  profileSafetyVerified: $('profile-safety-verified'),
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
  setIce: $('set-ice'),
  setPubkey: $('set-pubkey'),
  btnLogout: $('btn-logout'),

  chatmenuBackdrop: $('chatmenu-backdrop'),
  chatmenuTitle: $('chatmenu-title'),
  chatmenuBody: $('chatmenu-body'),
  btnChatmenuClose: $('btn-chatmenu-close'),
  ttlBackdrop: $('ttl-backdrop'),
  ttlOptions: $('ttl-options'),
  btnTtlClose: $('btn-ttl-close'),
  schedBackdrop: $('sched-backdrop'),
  schedList: $('sched-list'),
  schedEmpty: $('sched-empty'),
  btnSchedClose: $('btn-sched-close'),
  scheduleBackdrop: $('schedule-backdrop'),
  scheduleOptions: $('schedule-options'),
  btnScheduleClose: $('btn-schedule-close'),
  scheduleDatetime: $('schedule-datetime'),
  btnScheduleCustom: $('btn-schedule-custom'),
  drawerScheduledCount: $('drawer-scheduled-count'),
  menuPinLabel: $('menu-pin-label'),
  menuMuteLabel: $('menu-mute-label'),
  menuArchiveLabel: $('menu-archive-label'),
  menuTtl: $('menu-ttl'),
  menuTtlLabel: $('menu-ttl-label'),
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
  chatSearchFilters: $('chat-search-filters'),
  btnChatSearchFilter: $('btn-chat-search-filter'),
  csfKinds: $('csf-kinds'),
  csfFrom: $('csf-from'),
  csfDate: $('csf-date'),
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
  btnAdminUnverifyAll: $('btn-admin-unverify-all'),
  btnAdminRefresh: $('btn-admin-refresh'),
  btnAdminExport: $('btn-admin-export'),
  adminTabs: $('admin-tabs'),
  adminTabPanes: document.querySelectorAll('.admin-tabpane'),
  adminFilters: $('admin-filters'),
  adminLog: $('admin-log'),
  adminLogEmpty: $('admin-log-empty'),
  adminLogCount: $('admin-log-count'),
  adminAnnouncements: $('admin-announcements'),
  adminAnnouncementsEmpty: $('admin-announcements-empty'),
  adminAnnounceCount: $('admin-announce-count'),
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
  // Per-dialog flames, keyed by the peer's username: { count, active }. This is
  // the flame inside a chat, separate from the account-wide one above.
  dialogStreaks: new Map(),
  groups: new Map(), // groupId -> { id, name, owner, members: [] }
  channels: new Map(), // channelId -> { id, name, owner, subs, verified, ... }
  contacts: [], // usernames saved as contacts
  accounts: [], // [{ username, publicKey, active }]
  recording: null, // MediaRecorder state for voice notes
  selecting: null, // Set of message ids while in select mode
  isAdmin: false, // whether the signed-in account may open the admin panel
  adminUsers: [], // last admin user list, filtered client-side by the search box
  adminChannels: [], // last admin channel list, filtered client-side
  adminLog: [], // last admin action log, newest first
  adminAnnouncements: [], // last announcements, newest first
  adminFilter: 'all', // active filter chip in the users tab
  adminTab: 'users', // active admin tab
  adminAnnounceCount: 0,
  settingsPane: 'account', // active settings section
  drafts: {}, // peerKey -> unsent composer text, mirrored into account settings
  draftSaveTimer: null, // coalesces keystrokes into one settings write
  verifiedPeers: {}, // username -> true when the safety number was checked, mirrored into settings
  scheduled: [], // messages the account scheduled but has not sent yet
  schedulePending: null, // { to, text, replyTo, ttl } awaiting a send time
  folders: [], // chat folders ("папки"), mirrored into account settings
  activeFolder: 'all', // id of the selected folder tab
  searchFilter: { query: '', from: 'any', kind: 'any', date: 'any' }, // in-chat search
  folderEditing: null, // id of the folder open in the editor, or 'new'
  stories: [], // every active story the account may see, newest first
  storiesSeen: new Set(), // story ids this account has already opened
  storyGroup: null, // author whose stories the viewer is playing
  storyOrder: [], // authors in bar order, for prev/next across authors
  storyIndex: 0, // index into the current author's story list
  storyDraft: null, // { cap, kind, bg, ttl, attachment } while composing
  storyTimer: null, // autoplay timer for the viewer
  // Live call. Only one at a time; `pc` holds one RTCPeerConnection per remote
  // peer (a group call is a mesh, so one leg each).
  call: null, // { callId, key, video, role, peers:Map, localStream, startedAt, timer }
  // Бурмалда FM: the station, its playlist and the element that plays it.
  fm: { playlist: [], index: -1, mode: 'all', shuffle: false, playing: false, audio: null, dir: null },
  // Rockets and Premium. The relay owns the real numbers; these mirror them
  // for the interface and are refreshed from the relay on sign-in and on any
  // change, never computed locally.
  wallet: { balance: 0, premium: { active: false, until: null }, bundles: [], gifts: {}, pending: null }
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

/** 0 for "one", 1 for "few", 2 for "many" — a Russian-style plural index. */
function pluralIndex(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 0;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 1;
  return 2;
}

/** Russian plural form: 1 участник, 2 участника, 5 участников. */
function plural(n, one, few, many) {
  return [one, few, many][pluralIndex(n)];
}

/**
 * Story counts that agree with the language. English has no distinct plural
 * for the "new" adjective here, so its three forms collapse to one word.
 */
const STORY_WORDS = {
  ru: { unseen: ['новая', 'новые', 'новых'], views: ['просмотр', 'просмотра', 'просмотров'] },
  en: { unseen: ['new', 'new', 'new'], views: ['view', 'views', 'views'] }
};

function storyWord(kind, n) {
  const table = STORY_WORDS[i18n.getLang()] || STORY_WORDS.ru;
  return table[kind][pluralIndex(n)];
}

/** "N new" for a story ring, in the active language. */
function newCount(n) {
  return `${n} ${storyWord('unseen', n)}`;
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
  state.schedulePending = null;
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
  state.dialogStreaks.clear();
  state.stories = [];
  state.storiesSeen.clear();
  state.scheduled = [];
  setScheduledBadge();
  state.storyGroup = null;
  state.storyIndex = 0;
  if (els.storiesBar) els.storiesBar.hidden = true;
  if (els.meStreak) els.meStreak.hidden = true;
  await refreshStatus();
  api.version().then((v) => {
    const label = `v${v}`;
    if (els.footVer) els.footVer.textContent = label;
    if (els.drawerVer) els.drawerVer.textContent = label;
  }).catch(() => {});
  showScreen('main');
  await Promise.all([loadChats(), loadGroups(), loadChannels(), loadContacts(), loadStreak(), loadDrafts(), loadFolders(), loadStories(), loadVerifiedPeers(), refreshScheduled(), loadWallet()]);
  renderStoriesBar();
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
      if (!isMultiKey(key)) chat.ttl = row.ttl || 0;
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
      if (row.peer && row.streak) setDialogStreak(row.peer, row.streak);
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
      const last = lastRealMessage(items);
      if (last) chat.last = previewOf(last);
    } catch { /* leave the placeholder */ }
  }
  renderChatList();
}

/** The last real message of a transcript, ignoring control messages. */
function lastRealMessage(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (!m) continue;
    if (typeof m.kind === 'string' && m.kind.startsWith('system:')) continue;
    if (gamePayloadOf(m) || gameEndOf(m)) continue;
    return m;
  }
  return null;
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
      last: '', lastTs: 0, messages: [], loaded: false, ttl: 0
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
    state.drafts[key] || '', JSON.stringify(dialogStreakOf(peer))].join('\u0000');
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
        <span class="chat-item-time">${chatStreakChip(key)}${chat.lastTs ? escapeHtml(timeLabel(chat.lastTs)) : ''}</span>
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
  // The centered "series started" note. It is not a bubble from anyone, so it
  // carries no meta line and no context menu — just the flame and the words.
  if (m && m.kind === 'system:series') {
    const note = document.createElement('div');
    note.className = 'msg msg-system';
    note.dataset.id = m.id;
    note.innerHTML = `<span class="series-note">${icon('i-fire')}<span>У вас началась серия! Огонёк зажжён</span></span>`;
    return note;
  }
  // A local note from a hidden bot, e.g. the game offer from `@minigames`. It is
  // centered and quiet, like the series note, and never leaves this device.
  if (m && m.kind === 'system:bot') {
    const note = document.createElement('div');
    note.className = 'msg msg-system';
    note.dataset.id = m.id;
    note.innerHTML = `<span class="series-note bot-note">${icon('i-robot')}<span>${escapeHtml(m.text)}</span></span>`;
    return note;
  }
  const el = document.createElement('div');
  const hit = state.searchHits.includes(m.id);
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
  if (m.expiresAt && !m.deleted) {
    meta.push(`<span class="ttl-mark" data-exp="${m.expiresAt}" title="${escapeHtml(i18n.t('Исчезнет через'))}">${icon('i-clock')}<span class="ttl-remain"></span></span>`);
  }
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
  updateCallButtons(key);
  renderTtlChip();
  // Restore the draft left in this chat, unless the composer is read-only.
  els.composerInput.value = els.composerInput.disabled ? '' : draftFor(key);
  renderChatList();

  if (isBotKey(key)) {
    // A bot chat has no server history; its transcript is local. Open it as-is.
    renderDialogStreak();
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
      if (!isMultiKey(key)) {
        if (items.streak) setDialogStreak(peerUsername(key), items.streak);
        chat.ttl = items.ttl || 0;
      }
      renderMessages();
      renderTtlChip();
      const last = lastRealMessage(items);
      if (last) { chat.last = previewOf(last); chat.lastTs = last.ts; }
    } catch (err) {
      appendMessage({ text: (err.message || 'Could not load history'), ts: Date.now(), mine: false });
    }
  } else {
    renderMessages();
  }
  renderDialogStreak();
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
    // The "match over" notice is a control message too, so it stays out of view.
    if (gamePayloadOf(m) || pollVoteOf(m) || gameEndOf(m)) continue;
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
  tickTtlMarks();
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
  if (chat.gameMinimized) els.messages.appendChild(gameMinBar(chat));
  else els.messages.appendChild(messageEl({ __gameBoard: chat.game }));
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
  tickTtlMarks();
  return true;
}

/** Count the remaining seconds on every self-destructing bubble on screen. */
function tickTtlMarks() {
  const marks = els.messages.querySelectorAll('.ttl-mark');
  const now = Date.now();
  for (const mark of marks) {
    const left = Number(mark.dataset.exp) - now;
    const span = mark.querySelector('.ttl-remain');
    if (!span) continue;
    if (left <= 0) { span.textContent = i18n.t('сейчас'); continue; }
    const secs = Math.ceil(left / 1000);
    if (secs < 60) span.textContent = `${secs}${i18n.t('сек')}`;
    else if (secs < 3600) span.textContent = `${Math.ceil(secs / 60)}${i18n.t('мин')}`;
    else if (secs < 86400) span.textContent = `${Math.ceil(secs / 3600)}${i18n.t('ч')}`;
    else span.textContent = `${Math.ceil(secs / 86400)}${i18n.t('дн.')}`;
  }
}

function updateCallButtons(key) {
  const ok = !!key && !!CALLS && CALLS.supportsCalls(key);
  els.btnCallAudio.hidden = !ok;
  els.btnCallVideo.hidden = !ok;
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
  els.peerSub.textContent = presence || 'end-to-end encrypted';
  renderDialogStreak();
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
  if (els.searchMessagesWrap) { els.searchMessagesWrap.hidden = true; els.searchMessages.innerHTML = ''; }
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

  await renderGlobalSearch(query);
}

/* --------------------------- global search --------------------------- */
// The relay returns a decrypted slice of the newest history; we cache it so a
// burst of keystrokes does not re-fetch, and invalidate on any new message.
let globalSearchCache = { at: 0, items: [] };

function invalidateGlobalSearch() {
  globalSearchCache = { at: 0, items: [] };
}

/** Conversations in the shape the pure search layer expects. */
function searchConversations() {
  return [...state.chats.values()].map((chat) => ({
    key: chat.key, title: displayNameFor(chat.key), messages: chat.messages
  }));
}

/** Decrypt the newest slice of every chat, then filter it on the device. */
async function globalSearchItems() {
  const now = Date.now();
  if (now - globalSearchCache.at < 20000) return globalSearchCache.items;
  let items = [];
  try { items = await api.searchGlobal({ limit: 300 }); } catch { items = []; }
  globalSearchCache = { at: now, items };
  return items;
}

/** One "Сообщения" row: where it came from, who said it, a snippet, and when. */
function globalHitRow(hit) {
  const li = document.createElement('li');
  li.className = 'chat-item search-msg';
  const m = hit.message;
  const chat = state.chats.get(hit.chatKey);
  const who = m.mine ? 'Вы' : displayNameFor(m.from);
  li.innerHTML = `
    <div class="avatar small" data-color="${escapeHtml(avatarColorFor(hit.chatKey))}">${avatarInnerHtml(hit.chatKey, chat || {})}</div>
    <div class="chat-item-body">
      <div class="chat-item-top">
        <span class="chat-item-name">${escapeHtml(hit.title)}</span>
        <span class="chat-item-time">${escapeHtml(dayLabel(m.ts))}</span>
      </div>
      <div class="chat-item-last"><span class="search-msg-where">${escapeHtml(who)}:</span> ${escapeHtml(snippetOf(m))}</div>
    </div>
  `;
  li.addEventListener('click', () => {
    els.search.value = '';
    els.btnSearchClear.hidden = true;
    closeSearchPanel();
    openMessageFromSearch(hit.chatKey, m.id);
  });
  return li;
}

/** Open a chat and jump to a message, pulling older history when it is not in
 *  the page already. Group and channel history cannot be paged per message, so
 *  those simply open the chat. */
async function openMessageFromSearch(key, id) {
  ensureChat(key);
  renderChatList();
  await openChat(key);
  if (key === SAVED || isBotKey(key)) return;
  const chat = state.chats.get(key);
  if (chat && chat.loaded && !chat.messages.some((m) => m.id === id) && !isMultiKey(key)) {
    try {
      const items = await api.history({ with: peerUsername(key), limit: 300 });
      chat.messages = resolveQuotes(items);
      chat.loaded = true;
      renderMessages();
    } catch { /* keep what we have */ }
  }
  scrollToMessage(id, { smooth: false });
}

function snippetOf(m) {
  if (m.attachment && !m.text) return `📎 ${m.attachment.name || 'Вложение'}`;
  const text = (m.text || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Render the cross-chat "Сообщения" section for the current query. */
async function renderGlobalSearch(query) {
  if (!els.searchMessagesWrap || !SEARCH) return;
  const q = String(query || '').trim();
  if (q.length < 2) {
    els.searchMessagesWrap.hidden = true;
    els.searchMessages.innerHTML = '';
    return;
  }

  // Two sources: chats already open in memory, and the decrypted history slice
  // from the relay. A hit is deduplicated by chat + message id, in-memory wins
  // (direct and group ids come from different tables and can collide).
  const filter = { query: q, kind: 'any', from: 'any', date: 'any', now: Date.now() };
  const hits = SEARCH.searchAcross(searchConversations(), filter, { extrasOf: searchExtraOf, limit: 60 });
  const seen = new Set(hits.map((h) => `${h.chatKey}:${h.message.id}`));

  const items = await globalSearchItems();
  if (els.search.value.trim() !== q) return; // the box moved on while we decrypted
  for (const m of items) {
    const dedupKey = `${m.chatKey}:${m.id}`;
    if (seen.has(dedupKey)) continue;
    const hit = SEARCH.searchAcross(
      [{ key: m.chatKey, title: displayNameFor(m.chatKey), messages: [m] }],
      filter, { extrasOf: searchExtraOf, limit: 1 }
    )[0];
    if (hit) { hits.push(hit); seen.add(dedupKey); }
  }
  hits.sort((a, b) => (b.message.ts || 0) - (a.message.ts || 0));

  els.searchMessages.innerHTML = '';
  els.searchMessagesWrap.hidden = hits.length === 0;
  els.searchMessagesEmpty.hidden = hits.length > 0;
  for (const hit of hits.slice(0, 40)) els.searchMessages.appendChild(globalHitRow(hit));
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

  // A hidden bot mentioned in a personal chat is handled here and never sent:
  // the peer sees only the invitation that follows, if any, and the relay sees
  // nothing extra. See `runHiddenBotMention`.
  if (runHiddenBotMention(key, text)) return;

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
    pending: true, reactions: [],
    // Seed the countdown from the chat's timer so the bubble shows it at once;
    // the relay's `expiresAt` replaces this the moment the send is confirmed.
    expiresAt: chat.ttl ? Date.now() + chat.ttl : null
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
      const res = await api.send({
        to: peerUsername(key), text, replyTo: replyTo ? replyTo.id : undefined,
        ttl: chat.ttl || undefined
      });
      optimistic.id = res.id;
      if (res.expiresAt) optimistic.expiresAt = res.expiresAt;
    }
    noteLocalSend();
    optimistic.pending = false;
    renderMessages();
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
  // Auto-delete is a 1:1 feature; hide the entry for Saved, groups and channels.
  const ttlEligible = !isMultiKey(state.activePeer) && state.activePeer !== SAVED;
  els.menuTtl.hidden = !ttlEligible;
  if (ttlEligible) {
    els.menuTtlLabel.textContent = chat.ttl
      ? `${i18n.t('Автоудаление')}: ${ttlLabel(chat.ttl)}`
      : i18n.t('Автоудаление');
  }
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
    } else if (action === 'ttl') {
      openTtlPicker(key);
      return;
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

/* --------------------------- auto-delete timer --------------------------- */

/** The offered timers, in ms. 0 turns auto-delete off. */
const TTL_CHOICES = [0, 1000, 5000, 10000, 30000, 60000, 5 * 60000, 3600000, 86400000, 7 * 86400000];

/** A short, human label for a timer, e.g. "5 сек" or "1 день". */
function ttlLabel(ms) {
  if (!ms) return i18n.t('Выключено');
  if (ms < 60000) return `${Math.round(ms / 1000)} ${i18n.t('сек')}`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} ${i18n.t('мин')}`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)} ${i18n.t('ч')}`;
  return `${Math.round(ms / 86400000)} ${i18n.t('дн.')}`;
}

function renderTtlChip() {
  const chat = activeChat();
  const on = !!(chat && chat.ttl);
  els.peerTtl.hidden = !on;
  if (on) els.peerTtlLabel.textContent = ttlLabel(chat.ttl);
}

function openTtlPicker(key) {
  const chat = ensureChat(key);
  els.ttlOptions.innerHTML = '';
  for (const ms of TTL_CHOICES) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (ms === chat.ttl ? ' active' : '');
    b.innerHTML = `<span>${escapeHtml(ttlLabel(ms))}</span>`
      + (ms === chat.ttl ? `<span class="ttl-check">${icon('i-check')}</span>` : '');
    b.addEventListener('click', async () => {
      els.ttlBackdrop.hidden = true;
      try {
        const res = await api.chatTtl({ peer: peerUsername(key), ttl: ms });
        chat.ttl = res.ttl;
        renderTtlChip();
        toast(ms ? `${i18n.t('Автоудаление')}: ${ttlLabel(ms)}` : i18n.t('Автоудаление выключено'));
      } catch (err) {
        toast(err.message || 'Не удалось изменить таймер');
      }
    });
    els.ttlOptions.appendChild(b);
  }
  els.ttlBackdrop.hidden = false;
}

els.btnTtlClose.addEventListener('click', () => { els.ttlBackdrop.hidden = true; });
els.ttlBackdrop.addEventListener('click', (e) => {
  if (e.target === els.ttlBackdrop) els.ttlBackdrop.hidden = true;
});

/* --------------------------- scheduled messages --------------------------- */

// Quick choices for "send later", in minutes from now. 0 is not offered: a
// scheduled message must land in the future.
const SCHEDULE_QUICK = [60, 3 * 60, 8 * 60, 24 * 60, 7 * 24 * 60];

/** A short, human label for a future instant, e.g. "через 3 ч" or a date. */
function scheduleWhenLabel(ms) {
  const delta = ms - Date.now();
  if (delta < 0) return i18n.t('сейчас');
  if (delta < 3600000) return `${i18n.t('через')} ${Math.max(1, Math.round(delta / 60000))} ${i18n.t('мин')}`;
  if (delta < 86400000) return `${i18n.t('через')} ${Math.round(delta / 3600000)} ${i18n.t('ч')}`;
  if (delta < 7 * 86400000) return `${i18n.t('через')} ${Math.round(delta / 86400000)} ${i18n.t('дн.')}`;
  return new Date(ms).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** A one-line preview of a scheduled message, so the list reads like a chat. */
function schedulePreview(item) {
  if (item.attachment) {
    const k = item.attachment.kind;
    return k === 'image' ? i18n.t('Фото') : k === 'voice' ? i18n.t('Голосовое сообщение') : i18n.t('Файл');
  }
  return item.text || i18n.t('Сообщение');
}

function setScheduledBadge() {
  const n = state.scheduled.length;
  if (!els.drawerScheduledCount) return;
  els.drawerScheduledCount.hidden = !n;
  els.drawerScheduledCount.textContent = String(n);
}

async function refreshScheduled() {
  try {
    state.scheduled = await api.listScheduled();
  } catch {
    state.scheduled = [];
  }
  setScheduledBadge();
}

function renderScheduledList() {
  els.schedList.innerHTML = '';
  els.schedEmpty.hidden = state.scheduled.length > 0;
  for (const item of state.scheduled) {
    const row = document.createElement('div');
    row.className = 'sched-item';
    row.innerHTML = `
      <div class="sched-head">
        <span class="sched-peer">${escapeHtml(displayNameFor(item.to))}</span>
        <span class="sched-when">${escapeHtml(scheduleWhenLabel(item.sendAt))}</span>
      </div>
      <div class="sched-text">${escapeHtml(schedulePreview(item))}</div>
      <div class="sched-actions">
        <button class="menu-item" data-sched="now">${icon('i-send')}<span>${i18n.t('Сейчас')}</span></button>
        <button class="menu-item danger" data-sched="cancel">${icon('i-trash')}<span>${i18n.t('Отменить')}</span></button>
      </div>`;
    row.querySelector('[data-sched="now"]').addEventListener('click', () => sendScheduledNow(item));
    row.querySelector('[data-sched="cancel"]').addEventListener('click', () => cancelScheduled(item));
    els.schedList.appendChild(row);
  }
}

async function openScheduled() {
  await refreshScheduled();
  renderScheduledList();
  els.schedBackdrop.hidden = false;
}

async function cancelScheduled(item) {
  try {
    await api.cancelScheduled(item.id);
    state.scheduled = state.scheduled.filter((x) => x.id !== item.id);
    setScheduledBadge();
    renderScheduledList();
    toast(i18n.t('Отложенное сообщение отменено'));
  } catch (err) {
    toast(err.message || i18n.t('Не удалось отменить'));
  }
}

async function sendScheduledNow(item) {
  try {
    await api.sendScheduledNow(item.id);
    state.scheduled = state.scheduled.filter((x) => x.id !== item.id);
    setScheduledBadge();
    renderScheduledList();
    toast(i18n.t('Сообщение отправлено'));
  } catch (err) {
    toast(err.message || i18n.t('Не удалось отправить'));
  }
}

/** Ask for a send time, then hand the pending message to the relay. */
function openSchedulePicker(pending) {
  state.schedulePending = pending;
  els.scheduleOptions.innerHTML = '';
  for (const minutes of SCHEDULE_QUICK) {
    const when = Date.now() + minutes * 60000;
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.innerHTML = `<span>${escapeHtml(scheduleWhenLabel(when))}</span>`;
    b.addEventListener('click', () => commitSchedule(when));
    els.scheduleOptions.appendChild(b);
  }
  els.scheduleDatetime.value = '';
  els.scheduleBackdrop.hidden = false;
}

async function commitSchedule(sendAt) {
  const pending = state.schedulePending;
  els.scheduleBackdrop.hidden = true;
  if (!pending) return;
  state.schedulePending = null;
  if (!Number.isFinite(sendAt) || sendAt <= Date.now()) {
    toast(i18n.t('Выберите время в будущем'));
    return;
  }
  try {
    const res = await api.send({
      to: pending.to, text: pending.text, replyTo: pending.replyTo,
      attachment: pending.attachment, ttl: pending.ttl, sendAt
    });
    await refreshScheduled();
    toast(`${i18n.t('Отправлю')} ${scheduleWhenLabel(res.sendAt || sendAt)}`);
  } catch (err) {
    toast(err.message || i18n.t('Не удалось запланировать'));
  }
}

els.btnSchedClose.addEventListener('click', () => { els.schedBackdrop.hidden = true; });
els.schedBackdrop.addEventListener('click', (e) => {
  if (e.target === els.schedBackdrop) els.schedBackdrop.hidden = true;
});
els.btnScheduleClose.addEventListener('click', () => {
  els.scheduleBackdrop.hidden = true;
  state.schedulePending = null;
});
els.scheduleBackdrop.addEventListener('click', (e) => {
  if (e.target === els.scheduleBackdrop) { els.scheduleBackdrop.hidden = true; state.schedulePending = null; }
});
els.btnScheduleCustom.addEventListener('click', () => {
  const value = els.scheduleDatetime.value;
  if (!value) { toast(i18n.t('Выберите дату и время')); return; }
  const ts = new Date(value).getTime();
  commitSchedule(ts);
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
  renderSafetyNumber(p.username);
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

/**
 * Key verification. The safety number is derived on this device from the two
 * public keys, so it is the same on both ends and no server ever sees it. The
 * "verified" tick is a local note that the person compared the code out of
 * band; it is kept in the account settings so it survives a reload.
 */
async function renderSafetyNumber(username) {
  const self = username === state.username;
  els.profileSafety.hidden = self;
  if (self) return;
  els.profileSafetyNumber.textContent = '…';
  els.btnSafetyMark.hidden = false;
  paintSafetyVerified(username);
  try {
    els.profileSafetyNumber.textContent = await api.safetyNumber(username);
  } catch {
    els.profileSafetyNumber.textContent = 'Не удалось получить код';
  }
}

function paintSafetyVerified(username) {
  const on = !!state.verifiedPeers[username];
  els.profileSafetyVerified.hidden = !on;
  els.btnSafetyMark.hidden = on;
}

async function loadVerifiedPeers() {
  try {
    const s = await api.getSettings();
    state.verifiedPeers = (s && s.verifiedPeers && typeof s.verifiedPeers === 'object'
      && !Array.isArray(s.verifiedPeers)) ? { ...s.verifiedPeers } : {};
  } catch { /* offline: keep what we have */ }
}

els.btnSafetyCopy.addEventListener('click', async () => {
  const code = els.profileSafetyNumber.textContent;
  if (!code || code === '…') return;
  try { await navigator.clipboard.writeText(code); toast('Код скопирован'); }
  catch { toast('Не удалось скопировать'); }
});

els.btnSafetyMark.addEventListener('click', async () => {
  const username = state.profileTarget;
  if (!username) return;
  state.verifiedPeers[username] = true;
  paintSafetyVerified(username);
  try { await api.saveSettings({ verifiedPeers: state.verifiedPeers }); } catch { /* best effort */ }
  toast('Отмечено как проверенный');
});

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
  els.setIce.value = Array.isArray(s.iceServers) ? s.iceServers.join(', ') : '';
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

/** Render the admin summary and every tab from the relay. */
async function loadAdminPanel() {
  if (!state.isAdmin) return;
  els.adminUsers.innerHTML = '<p class="panel-empty">Загрузка…</p>';
  els.adminUsersEmpty.hidden = true;
  try {
    const [{ stats, announcements, log }, users, channels] = await Promise.all([
      api.adminOverview(),
      api.adminUsers(),
      api.adminChannels().catch(() => [])
    ]);
    els.adminStats.innerHTML = adminStatCard(stats.users, 'Пользователей') +
      adminStatCard(stats.online, 'Онлайн') +
      adminStatCard(stats.messages, 'Сообщений') +
      adminStatCard(stats.groups, 'Групп') +
      adminStatCard(stats.channels, 'Каналов') +
      adminStatCard(stats.verified, 'Проверено') +
      adminStatCard(stats.admins, 'Админов') +
      adminStatCard(stats.banned, 'Заблокировано') +
      adminStatCard(stats.flames, 'Огоньков') +
      adminStatCard(stats.sessions, 'Сессий');
    state.adminUsers = users;
    state.adminChannels = channels;
    state.adminLog = log || [];
    state.adminAnnouncements = announcements;
    state.adminAnnounceCount = announcements.length;
    renderAdminUsers();
    renderAdminChannels();
    renderAdminLog();
    renderAdminAnnouncements();
  } catch (err) {
    els.adminUsers.innerHTML = '';
    els.adminUsersEmpty.hidden = false;
    els.adminUsersEmpty.textContent = err.message || 'Не удалось загрузить панель';
  }
}

function adminStatCard(value, label) {
  const n = value == null ? 0 : value;
  return `<div class="admin-stat"><span class="admin-stat-num">${n}</span><span class="admin-stat-label">${escapeHtml(label)}</span></div>`;
}

/** Switch the visible admin tab. */
function selectAdminTab(name) {
  state.adminTab = name;
  els.adminTabs.querySelectorAll('.admin-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  els.adminTabPanes.forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
}

/** Human labels for the admin log's action names. */
const ADMIN_ACTION_LABELS = {
  announce: 'Объявление',
  channelVerify: 'Галочка канала',
  channelDelete: 'Удаление канала',
  channelUnverifyAll: 'Снятие галочек каналов',
  verify: 'Галочка',
  badge: 'Значок',
  grantAdmin: 'Права админа',
  nicknameAdd: 'Никнейм добавлен',
  nicknameRemove: 'Никнейм убран',
  nicknameSet: 'Никнейм изменён',
  ban: 'Блокировка',
  forceLogout: 'Принудительный выход',
  resetProfile: 'Профиль очищен',
  clearMessages: 'История очищена',
  delete: 'Аккаунт удалён'
};

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Draw the action log, newest first. */
function renderAdminLog() {
  const rows = state.adminLog || [];
  els.adminLog.innerHTML = '';
  els.adminLogCount.textContent = String(rows.length);
  els.adminLogEmpty.hidden = rows.length > 0;
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'admin-log-row';
    const label = ADMIN_ACTION_LABELS[r.action] || r.action;
    const target = r.target ? ` <b>@${escapeHtml(r.target)}</b>` : '';
    row.innerHTML = `
      <span class="admin-log-dot" data-act="${escapeHtml(r.action)}"></span>
      <div class="admin-log-body">
        <div class="admin-log-line">${escapeHtml(label)}${target}</div>
        <div class="admin-log-sub">${escapeHtml(r.actor)} · ${fmtDateTime(r.ts)}${r.detail ? ' · ' + escapeHtml(r.detail) : ''}</div>
      </div>`;
    els.adminLog.appendChild(row);
  }
}

/** Draw the past announcements, newest first. */
function renderAdminAnnouncements() {
  const rows = state.adminAnnouncements || [];
  els.adminAnnouncements.innerHTML = '';
  els.adminAnnounceCount.textContent = String(rows.length);
  els.adminAnnouncementsEmpty.hidden = rows.length > 0;
  for (const a of rows) {
    const row = document.createElement('div');
    row.className = 'admin-log-row';
    row.innerHTML = `
      <span class="admin-log-dot" data-act="announce"></span>
      <div class="admin-log-body">
        <div class="admin-log-line">${escapeHtml(a.text)}</div>
        <div class="admin-log-sub">${escapeHtml(a.sender)} · ${fmtDateTime(a.ts)}</div>
      </div>`;
    els.adminAnnouncements.appendChild(row);
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

/** Does a user row pass the active filter chip? */
function adminUserMatchesFilter(u, filter) {
  if (filter === 'online') return !!u.online;
  if (filter === 'verified') return !!u.verified;
  if (filter === 'admins') return !!u.admin;
  if (filter === 'banned') return !!u.banned;
  return true;
}

/** Draw the user list, honouring the search box and the filter chips. */
function renderAdminUsers() {
  const query = (els.adminUsersSearch.value || '').trim().toLowerCase();
  const filter = state.adminFilter || 'all';
  const users = (state.adminUsers || []).filter((u) => {
    if (!adminUserMatchesFilter(u, filter)) return false;
    return !query || u.username.toLowerCase().includes(query) ||
      (u.displayName || '').toLowerCase().includes(query);
  });
  els.adminUsers.innerHTML = '';
  els.adminUsersCount.textContent = String((state.adminUsers || []).length);
  els.adminUsersEmpty.hidden = users.length > 0;
  if (!users.length) {
    els.adminUsersEmpty.textContent = (query || filter !== 'all') ? 'Никого не найдено.' : 'Пользователей пока нет.';
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'admin-user';
    if (u.banned) row.classList.add('is-banned');
    const flags = [
      u.admin ? '<span class="admin-tag admin">админ</span>' : '',
      u.adminByConfig ? '<span class="admin-tag admin">по конфигу</span>' : '',
      u.verified ? '<span class="admin-tag verified">проверен</span>' : '',
      u.banned ? '<span class="admin-tag banned">заблокирован</span>' : '',
      u.online ? '<span class="admin-tag online">онлайн</span>' : '',
      u.profileHidden ? '<span class="admin-tag">скрытый профиль</span>' : ''
    ].filter(Boolean).join(' ');
    const lastSeen = u.online ? 'сейчас' : (u.lastSeen ? fmtDateTime(u.lastSeen) : 'не заходил');
    row.innerHTML = `
      <div class="avatar small" data-color="${escapeHtml(u.avatarColor || 'mint')}">${avatarInnerHtml(u.username, u)}</div>
      <div class="admin-user-body">
        <div class="admin-user-name">${escapeHtml(u.displayName || u.username)} ${flags}</div>
        <div class="admin-user-sub"><span class="admin-at" data-user="${escapeHtml(u.username)}" title="Наведите, чтобы менять никнеймы">@${escapeHtml(u.username)}</span>${nicknameSummary(u.nicknames)}</div>
        <div class="admin-user-meta">${u.sent} отпр. · ${u.received} получ. · ${u.groups} групп · ${u.subs} подписок · был(а): ${lastSeen}</div>
      </div>
      <div class="admin-user-actions">
        <button class="admin-act${u.verified ? ' on' : ''}" data-act="verify" data-user="${escapeHtml(u.username)}" title="${u.verified ? 'Снять галочку' : 'Дать галочку'}">${icon('i-check')}</button>
        <button class="admin-act${u.badgeImage ? ' on' : ''}" data-act="badge" data-user="${escapeHtml(u.username)}" title="${u.badgeImage ? 'Заменить значок' : 'Свой значок вместо галочки'}">${icon('i-image')}</button>
        <button class="admin-act${u.admin ? ' on' : ''}" data-act="grantAdmin" data-user="${escapeHtml(u.username)}" title="${u.admin ? 'Снять админа' : 'Сделать админом'}">${icon('i-shield')}</button>
        <button class="admin-act danger${u.banned ? ' on' : ''}" data-act="ban" data-user="${escapeHtml(u.username)}" title="${u.banned ? 'Разблокировать' : 'Заблокировать'}">${icon('i-ban')}</button>
        <button class="admin-act" data-act="more" data-user="${escapeHtml(u.username)}" title="Ещё действия">${icon('i-more')}</button>
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
        <div class="admin-user-sub">@${escapeHtml(c.owner)}${c.handle ? ' · ' + escapeHtml(c.handle) : ''} · ${c.subs} подписчиков · ${c.posts} постов</div>
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
els.btnAdminUnverifyAll.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Снять галочки со всех каналов?',
    text: 'Все каналы потеряют значок «проверен». Отменить это действие нельзя.',
    confirmLabel: 'Снять'
  });
  if (!ok) return;
  try {
    await api.adminAction({ action: 'channelUnverifyAll' });
    toast('Готово');
    loadAdminPanel();
  } catch (err) {
    toast(err.message || 'Не удалось выполнить действие');
  }
});

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

/** A small popup of the less common per-account actions. */
let adminMorePop = null;

function closeAdminMorePop() {
  if (adminMorePop) { adminMorePop.remove(); adminMorePop = null; }
}

function openAdminMorePop(anchor, user) {
  closeAdminMorePop();
  const row = (state.adminUsers || []).find((u) => u.username === user) || {};
  const pop = document.createElement('div');
  pop.className = 'admin-more-pop';
  const items = [
    { act: 'forceLogout', label: 'Выйти на всех устройствах', danger: false },
    { act: 'resetProfile', label: 'Очистить профиль', danger: false },
    { act: 'clearMessages', label: 'Удалить переписку', danger: true },
    { act: 'delete', label: 'Удалить аккаунт', danger: true }
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'admin-more-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { closeAdminMorePop(); runAdminAction(it.act, user, row); });
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  adminMorePop = pop;
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - 240);
  const top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

document.addEventListener('click', (e) => {
  if (adminMorePop && !e.target.closest('.admin-more-pop') && !e.target.closest('[data-act="more"]')) {
    closeAdminMorePop();
  }
});

/** Run one admin action, with the confirmation its risk warrants. */
async function runAdminAction(act, user, row) {
  const confirmations = {
    delete: { title: 'Удалить аккаунт?', text: `Аккаунт @${user} и все его сообщения будут удалены безвозвратно.`, confirmLabel: 'Удалить' },
    clearMessages: { title: 'Удалить переписку?', text: `Все сообщения @${user} будут удалены с ретранслятора у обоих собеседников.`, confirmLabel: 'Удалить' },
    forceLogout: { title: 'Выйти на всех устройствах?', text: `@${user} будет отключён на всех устройствах. Войти снова можно с тем же паролем.`, confirmLabel: 'Выйти' },
    resetProfile: { title: 'Очистить профиль?', text: `Имя, описание, аватар, соцсети и никнеймы @${user} будут стёрты. Сообщения не тронуты.`, confirmLabel: 'Очистить' }
  };
  const c = confirmations[act];
  if (c) {
    const ok = await confirmDialog(c);
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
}

els.adminUsers.addEventListener('click', async (e) => {
  const btn = e.target.closest('.admin-act');
  if (!btn) return;
  const { act, user } = btn.dataset;
  if (act === 'badge') {
    const row = (state.adminUsers || []).find((u) => u.username === user);
    badgeDialogOpen(user, row && row.badgeImage);
    return;
  }
  if (act === 'more') {
    openAdminMorePop(btn, user);
    return;
  }
  await runAdminAction(act, user, (state.adminUsers || []).find((u) => u.username === user));
});

els.adminUsersSearch.addEventListener('input', renderAdminUsers);
els.btnAdminRefresh.addEventListener('click', () => loadAdminPanel());

els.adminTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.admin-tab');
  if (tab) selectAdminTab(tab.dataset.tab);
});

els.adminFilters.addEventListener('click', (e) => {
  const chip = e.target.closest('.admin-filter');
  if (!chip) return;
  state.adminFilter = chip.dataset.filter;
  els.adminFilters.querySelectorAll('.admin-filter').forEach((c) => {
    c.classList.toggle('active', c.dataset.filter === state.adminFilter);
  });
  renderAdminUsers();
});

/** Write a plain-text moderation report and hand it to the user to save. */
function exportAdminReport() {
  const lines = [];
  const when = new Date().toLocaleString();
  lines.push(`SleePhy — отчёт админ-панели (${when})`, '');
  lines.push(`Пользователей: ${(state.adminUsers || []).length}`);
  lines.push(`Каналов: ${(state.adminChannels || []).length}`);
  lines.push(`Объявлений: ${(state.adminAnnouncements || []).length}`, '');
  lines.push('== Пользователи ==');
  for (const u of state.adminUsers || []) {
    const tags = [u.admin ? 'админ' : '', u.verified ? 'проверен' : '', u.banned ? 'заблокирован' : '', u.online ? 'онлайн' : '']
      .filter(Boolean).join(', ');
    lines.push(`@${u.username}\t${u.displayName || ''}\t${tags}\tотпр:${u.sent}\tполуч:${u.received}`);
  }
  lines.push('', '== Каналы ==');
  for (const c of state.adminChannels || []) {
    lines.push(`${c.name}\t@${c.owner}\t${c.verified ? 'проверен' : ''}\tподписчиков:${c.subs}`);
  }
  lines.push('', '== Журнал ==');
  for (const r of state.adminLog || []) {
    lines.push(`${fmtDateTime(r.ts)}\t${r.actor}\t${ADMIN_ACTION_LABELS[r.action] || r.action}\t${r.target || ''}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sleephy-admin-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Отчёт сохранён');
}

els.btnAdminExport.addEventListener('click', exportAdminReport);

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
    // Refresh so the sent announcement appears in the history and the log.
    loadAdminPanel();
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

els.setIce.addEventListener('change', async () => {
  const servers = els.setIce.value.split(',').map((s) => s.trim()).filter(Boolean);
  await persistSettings({ iceServers: servers });
  toast(servers.length ? 'Серверы ICE сохранены' : 'Серверы ICE очищены');
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
// The account-wide "огонёк" is no longer drawn anywhere: the flame now belongs
// to the *dialog* (see renderDialogStreak). The value is still fetched and kept
// so a profile view and a future account screen can use it.
function renderSelfStreak() {
  const s = state.streak;
  if (!els.meStreak) return;
  if (!s || !s.count) { els.meStreak.hidden = true; return; }
  els.meStreak.hidden = false;
  els.meStreakCount.textContent = String(s.count);
  els.meStreak.classList.toggle('on', !!s.active);
  els.meStreak.title = s.active
    ? `Огонёк: ${s.count} ${plural(s.count, 'день', 'дня', 'дней')} подряд`
    : `Огонёк: ${s.count} ${plural(s.count, 'день', 'дня', 'дней')}. Отправьте сообщение, чтобы продлить.`;
}

/* ----------------------------- dialog streak ----------------------------- */
// The flame *inside a chat*: days in a row this pair has written to each other.
// It replaces the old account-level chip in the header and, on the day it first
// appears, leaves a centered "series started" note in the transcript.

/** Remember the flame for a peer from any reply that carried it. */
function setDialogStreak(peer, streak) {
  if (!peer || !streak) return;
  state.dialogStreaks.set(peer, { count: streak.count || 0, active: !!streak.active });
}

function dialogStreakOf(peer) {
  return peer ? state.dialogStreaks.get(peer) || null : null;
}

/** Paint the flame chip in the open chat header. */
function renderDialogStreak() {
  if (!els.peerStreak) return;
  const key = state.activePeer;
  const peer = key && !isMultiKey(key) && key !== SAVED ? peerUsername(key) : null;
  const s = dialogStreakOf(peer);
  if (!s || !s.count) { els.peerStreak.hidden = true; return; }
  els.peerStreak.hidden = false;
  els.peerStreakCount.textContent = String(s.count);
  els.peerStreak.classList.toggle('on', !!s.active);
  const days = plural(s.count, 'день', 'дня', 'дней');
  els.peerStreak.title = s.active
    ? `Огонёк диалога: ${s.count} ${days} подряд`
    : `Огонёк диалога: ${s.count} ${days}. Отправьте сообщение, чтобы продлить.`;
}

/** The little flame on a chat-list row, so the streak shows without opening it. */
function chatStreakChip(key) {
  const peer = key && !isMultiKey(key) && key !== SAVED ? peerUsername(key) : null;
  const s = dialogStreakOf(peer);
  if (!s || !s.count) return '';
  return `<span class="streak-chip streak-chip-sm${s.active ? ' on' : ''}" title="Огонёк диалога">`
    + icon('i-fire') + `<span>${s.count}</span></span>`;
}

/**
 * Paint the streak line of the open profile from the cached profile fields.
 */
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
 * Sending lights the *dialog* flame without waiting for a round trip. The relay
 * reconciles the count on the next history load; this only makes the send feel
 * immediate and lets the "series started" note appear at once.
 */
function noteLocalSend() {
  const key = state.activePeer;
  if (!key || isMultiKey(key) || key === SAVED) return;
  const peer = peerUsername(key);
  const s = dialogStreakOf(peer);
  if (s && s.active) return;
  setDialogStreak(peer, { count: (s ? s.count : 0) + 1, active: true });
  renderDialogStreak();
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

/* ================================ CALLS ================================ */
// WebRTC signaling lives here; the media flows peer-to-peer and the relay only
// forwards the handshake. A direct call is one RTCPeerConnection; a group call
// is a mesh, one connection per remote peer, addressed by username in every
// signal frame. The UI is a single overlay so a call survives whatever screen
// is open behind it.

let ringtoneAudio = null;
let ringtoneManifest = null; // loaded once, then reused for every call

/** Load the ringtone manifest once; absence is normal. */
async function loadRingtoneManifest() {
  if (ringtoneManifest !== null) return ringtoneManifest;
  try {
    const res = await api.readMediaManifest('ringtones');
    ringtoneManifest = { ...(res && res.manifest), dir: res && res.dir };
  } catch { ringtoneManifest = {}; }
  return ringtoneManifest;
}

/** Turn a folder path from the main process into a URL the page can load. */
function mediaUrl(dir, name) {
  if (!dir) return `assets/ringtones/${name}`;
  return 'file:///' + encodeURI(String(dir).replace(/\\/g, '/').replace(/^\/+/, '')) + '/' + name;
}

/** Play the configured ringtone, else a short synthesized chime. */
function startRing(kind) {
  stopRing();
  loadRingtoneManifest().then((manifest) => {
    const rel = CALLS ? CALLS.ringtoneFile(kind, manifest) : null;
    if (!rel) { startRingToneFallback(kind); return; }
    const name = rel.replace(/^assets\/ringtones\//, '');
    const el = new Audio(mediaUrl(manifest.dir, name));
    el.loop = true;
    el.volume = 0.5;
    el.onerror = () => startRingToneFallback(kind);
    el.play().then(() => { ringtoneAudio = el; }).catch(() => startRingToneFallback(kind));
  });
}

function stopRing() {
  if (ringtoneAudio) { try { ringtoneAudio.pause(); } catch { /* gone */ } ringtoneAudio = null; }
  if (ringFallbackTimer) { clearInterval(ringFallbackTimer); ringFallbackTimer = null; }
  if (ringFallbackCtx) { try { ringFallbackCtx.close(); } catch { /* gone */ } ringFallbackCtx = null; }
}

let ringFallbackTimer = null;
let ringFallbackCtx = null;
/** A two-note chime, repeated, when no ringtone file ships with the build. */
function startRingToneFallback(kind) {
  if (kind === 'ended') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ringFallbackCtx = ctx;
    const beep = (freq, at) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      osc.start(at); osc.stop(at + 0.34);
    };
    const ring = () => {
      if (!ringFallbackCtx) return;
      const t = ctx.currentTime;
      beep(660, t); beep(520, t + 0.4);
    };
    ring();
    ringFallbackTimer = setInterval(ring, 1800);
  } catch { /* no audio in this environment */ }
}

function callKeyOf(from, groupId) {
  return groupId != null ? groupKey(groupId) : chatKey(from);
}

/** Paint the overlay for whichever call is live. */
function renderCall() {
  const call = state.call;
  if (!call) { els.callOverlay.hidden = true; return; }
  els.callOverlay.hidden = false;
  const key = call.key;
  els.callTitle.textContent = displayNameFor(key);
  paintAvatar(els.callAvatar, peerUsername(key));
  els.btnCallCam.hidden = !call.video;
  els.btnCallMic.classList.toggle('off', !!call.micOff);
  els.btnCallCam.classList.toggle('off', !!call.camOff);

  if (call.status === 'active') {
    els.callTimer.hidden = false;
    els.callSub.textContent = CALLS ? CALLS.describeParticipants(call.names, state.username) : '';
  } else {
    els.callTimer.hidden = true;
    els.callSub.textContent = CALLS ? (CALLS.callStatusLabel(call.status, call.video) || '') : '';
  }
}

/** One video tile per remote peer; audio-only peers get an avatar tile. */
function addVideoTile(peer, stream) {
  let tile = els.callVideos.querySelector(`[data-peer="${CSS.escape(peer)}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.dataset.peer = peer;
    const label = document.createElement('div');
    label.className = 'call-tile-name';
    label.textContent = displayNameFor(peer);
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    tile.append(video, label);
    els.callVideos.append(tile);
  }
  const video = tile.querySelector('video');
  if (video.srcObject !== stream) video.srcObject = stream;
  if (!stream || stream.getVideoTracks().length === 0) tile.classList.add('audio-only');
  else tile.classList.remove('audio-only');
}

function removeVideoTile(peer) {
  const tile = els.callVideos.querySelector(`[data-peer="${CSS.escape(peer)}"]`);
  if (tile) tile.remove();
}

/** Tear down every leg, stop the ring and hide the overlay. */
function endCallLocal(reason) {
  const call = state.call;
  if (!call) return;
  if (call.timer) clearInterval(call.timer);
  for (const [, leg] of call.peers) { try { leg.pc.close(); } catch { /* gone */ } }
  if (call.localStream) for (const t of call.localStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
  state.call = null;
  els.callVideos.replaceChildren();
  stopRing();
  els.callOverlay.hidden = true;
  els.callRing.hidden = true;
  if (reason) toast(reason);
}

function iceServers() {
  const extra = Array.isArray(state.settings.iceServers) ? state.settings.iceServers : [];
  const base = CALLS ? CALLS.DEFAULT_ICE : [];
  return [...base, ...extra];
}

/**
 * Build (or reuse) the peer connection for one remote peer. The offerer is the
 * side that adds its tracks and creates the offer; the answerer only answers,
 * so a leg is negotiated exactly once.
 */
function peerConnectionFor(peer, { initiator }) {
  const call = state.call;
  if (!call) return null;
  let leg = call.peers.get(peer);
  if (leg) return leg.pc;

  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  leg = { pc, remoteSet: false };
  call.peers.set(peer, leg);

  if (call.localStream) {
    for (const track of call.localStream.getTracks()) pc.addTrack(track, call.localStream);
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      api.callSignal({ callId: call.callId, to: peer, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }).catch(() => {});
    }
  };
  pc.ontrack = (e) => { addVideoTile(peer, e.streams[0]); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && call.status !== 'active') markCallActive();
    if (pc.connectionState === 'failed') { toast(`Соединение с ${displayNameFor(peer)} прервано`); }
  };

  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await api.callSignal({ callId: call.callId, to: peer, sdp: pc.localDescription.sdp });
      } catch { /* the call may have ended */ }
    };
  }
  return pc;
}

function markCallActive() {
  const call = state.call;
  if (!call || call.status === 'active') return;
  call.status = 'active';
  call.startedAt = Date.now();
  stopRing();
  call.timer = setInterval(() => {
    if (!state.call) return;
    els.callTimer.textContent = CALLS ? CALLS.formatDuration(Date.now() - state.call.startedAt) : '00:00';
  }, 500);
  els.callTimer.textContent = '00:00';
  renderCall();
}

/** Capture the microphone (and camera for a video call). */
async function acquireLocalMedia(video) {
  const constraints = { audio: true, video: video ? { width: 1280, height: 720 } : false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return stream;
}

async function startCall(key, video) {
  if (state.call) { toast('Уже идёт звонок'); return; }
  if (CALLS && !CALLS.supportsCalls(key)) { toast('В этот чат нельзя позвонить'); return; }
  let stream;
  try {
    stream = await acquireLocalMedia(video);
  } catch {
    toast('Нет доступа к микрофону' + (video ? ' или камере' : ''));
    return;
  }
  const group = isGroupKey(key);
  const target = group ? { groupId: groupIdOf(key) } : { to: peerUsername(key) };
  let res;
  try {
    res = await api.callInvite({ ...target, video });
  } catch (err) {
    for (const t of stream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
    toast(err.message || 'Не удалось позвонить');
    return;
  }
  state.call = {
    callId: res.callId, key, video, role: 'caller', status: 'outgoing',
    peers: new Map(), localStream: stream, startedAt: 0, timer: null,
    pendingSignals: [], names: [state.username, ...(res.participants || [])]
  };
  // Legs are built when each peer answers (see the call.answered handler), not
  // now: an offer sent before the callee picks up would start their microphone
  // while the phone is still ringing.
  startRing('outgoing');
  renderCall();
}

/** Accept an incoming ring: build the mesh and answer. */
async function acceptIncoming() {
  const pending = state.call;
  if (!pending || pending.status !== 'incoming') return;
  let stream;
  try {
    stream = await acquireLocalMedia(pending.video);
  } catch {
    toast('Нет доступа к микрофону' + (pending.video ? ' или камере' : ''));
    declineCall();
    return;
  }
  pending.localStream = stream;
  pending.role = 'callee';
  stopRing();
  const res = await api.callAnswer({ callId: pending.callId, video: pending.video });
  const others = (res && res.participants) || [];
  pending.names = [state.username, ...others.filter((u) => u !== state.username)];
  // Legs are built lazily as each offer arrives (see onCallSignal); building
  // them now would open connections to peers who have not picked up yet.
  pending.status = 'connecting';
  els.callRing.hidden = true;
  renderCall();
}

function declineCall() {
  const call = state.call;
  if (!call) return;
  if (call.callId) api.callDecline({ callId: call.callId }).catch(() => {});
  endCallLocal('Звонок отклонён');
}

function hangup() {
  const call = state.call;
  if (!call) return;
  if (call.callId) api.callHangup({ callId: call.callId }).catch(() => {});
  endCallLocal('Звонок завершён');
}

/** An incoming ring arrived: show the card and start the ringtone. */
function onIncomingCall(evt) {
  if (state.call) {
    // Already busy: tell the caller no one is free to pick up.
    api.callDecline({ callId: evt.callId }).catch(() => {});
    return;
  }
  const key = callKeyOf(evt.from, evt.groupId);
  state.call = {
    callId: evt.callId, key, video: !!evt.video, role: 'callee', status: 'incoming',
    peers: new Map(), localStream: null, startedAt: 0, timer: null, names: [state.username]
  };
  els.ringTitle.textContent = displayNameFor(key);
  els.ringSub.textContent = CALLS ? (CALLS.callStatusLabel('incoming', evt.video) || 'Входящий звонок') : 'Входящий звонок';
  paintAvatar(els.ringAvatar, peerUsername(key));
  els.callRing.hidden = false;
  startRing('incoming');
}

/** Replay any signal frames that arrived before their leg was built. */
function flushPendingSignals(peer) {
  const call = state.call;
  if (!call || !call.pendingSignals) return;
  const mine = call.pendingSignals.filter((s) => s.from === peer);
  call.pendingSignals = call.pendingSignals.filter((s) => s.from !== peer);
  for (const s of mine) onCallSignal(s);
}

/** A signaling frame from a peer: an SDP offer/answer or an ICE candidate. */
async function onCallSignal(evt) {
  const call = state.call;
  if (!call || evt.callId !== call.callId) return;
  const peer = evt.from;
  // The answerer builds the leg when the first signal from that peer arrives;
  // the caller builds it on call.answered. A frame that beats its leg is held
  // briefly rather than dropped, because dropping an offer would dead-end the
  // call and dropping a candidate would only slow it down.
  if (!call.peers.has(peer)) {
    if (call.role === 'callee') peerConnectionFor(peer, { initiator: false });
    else { call.pendingSignals.push(evt); return; }
  }
  const leg = call.peers.get(peer);
  const pc = leg && leg.pc;
  if (!pc) return;
  try {
    if (evt.sdp) {
      const desc = { type: pc.signalingState === 'have-local-offer' ? 'answer' : 'offer', sdp: evt.sdp };
      await pc.setRemoteDescription(desc);
      leg.remoteSet = true;
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await api.callSignal({ callId: call.callId, to: peer, sdp: pc.localDescription.sdp });
      }
    } else if (evt.candidate) {
      try { await pc.addIceCandidate(evt.candidate); } catch { /* late candidate */ }
    }
  } catch { /* a malformed frame must not break the call */ }
}

els.btnCallAudio.addEventListener('click', () => {
  if (state.activePeer) startCall(state.activePeer, false);
});
els.btnCallVideo.addEventListener('click', () => {
  if (state.activePeer) startCall(state.activePeer, true);
});
els.btnRingAccept.addEventListener('click', acceptIncoming);
els.btnRingDecline.addEventListener('click', declineCall);
els.btnCallEnd.addEventListener('click', hangup);
els.btnCallMic.addEventListener('click', () => {
  const call = state.call; if (!call || !call.localStream) return;
  call.micOff = !call.micOff;
  for (const t of call.localStream.getAudioTracks()) t.enabled = !call.micOff;
  renderCall();
});
els.btnCallCam.addEventListener('click', () => {
  const call = state.call; if (!call || !call.localStream) return;
  call.camOff = !call.camOff;
  for (const t of call.localStream.getVideoTracks()) t.enabled = !call.camOff;
  renderCall();
});
els.btnCallScreen.addEventListener('click', async () => {
  const call = state.call; if (!call) return;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = display.getVideoTracks()[0];
    for (const [peer, leg] of call.peers) {
      const sender = leg.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(track);
    }
    toast('Показ экрана включён');
  } catch { /* the user dismissed the picker */ }
});

/* =========================== ROCKETS AND PREMIUM =========================== */
// The relay owns the money: it decides what a bundle costs, whether a payment
// went through, and what the balance is. Everything here draws that state and
// asks the relay to change it; nothing is computed locally.

async function loadWallet() {
  try {
    const res = await api.wallet();
    applyWallet(res);
  } catch { /* not signed in yet, or the relay is away */ }
}

/** Fold a wallet state (from a call or a push) into the interface. */
function applyWallet(res) {
  if (!res) return;
  if (typeof res.balance === 'number') state.wallet.balance = res.balance;
  if (res.premium) state.wallet.premium = res.premium;
  if (Array.isArray(res.bundles) && res.bundles.length) state.wallet.bundles = res.bundles;
  if (res.gifts && Object.keys(res.gifts).length) state.wallet.gifts = res.gifts;
  renderWallet();
  if (!els.giftsBackdrop.hidden) renderGiftShelf();
}

function premiumUntilLabel(until) {
  if (!until) return '';
  const d = new Date(until);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderWallet() {
  const w = state.wallet;
  const premium = w.premium || { active: false, until: null };
  if (els.rocketsBalance) els.rocketsBalance.textContent = String(w.balance);
  if (els.rocketsNote && MONEY) {
    const unit = w.bundles.length && w.bundles[0].rockets
      ? w.bundles[0].priceRub / w.bundles[0].rockets
      : null;
    els.rocketsNote.textContent = unit
      ? `1 ракета — ${unit.toFixed(2)} ₽. Покупка проходит на стороне платёжного сервиса; мессенджер видит только номер платежа.`
      : 'Покупка проходит на стороне платёжного сервиса; мессенджер видит только номер платежа.';
  }
  if (els.premiumBadge) {
    els.premiumBadge.textContent = premium.active ? 'Активна' : 'Не активна';
    els.premiumBadge.classList.toggle('on', premium.active);
  }
  if (els.premiumStatus) {
    els.premiumStatus.textContent = premium.active
      ? `Активна до ${premiumUntilLabel(premium.until)}`
      : 'Подписка не оформлена';
  }
  if (els.premiumPrice && premium.priceRub) els.premiumPrice.textContent = String(premium.priceRub);
  if (els.premiumCta) {
    els.premiumCta.textContent = premium.active ? 'Продлить за' : 'Оформить за';
  }
  if (els.rocketBundles) {
    els.rocketBundles.replaceChildren();
    for (const b of w.bundles) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rocket-bundle';
      btn.dataset.rockets = String(b.rockets);
      btn.innerHTML = `<span class="rocket-bundle-num">${b.rockets}</span>` +
        `<span class="rocket-bundle-unit">${MONEY ? MONEY.rocketWord(b.rockets) : 'ракет'}</span>` +
        `<span class="rocket-bundle-price">${b.priceRub} ₽</span>`;
      btn.addEventListener('click', () => buyBundle(b.rockets));
      els.rocketBundles.append(btn);
    }
  }
}

/**
 * Pay for something. The relay hands back a checkout URL when a real provider
 * is configured; that opens in the system browser, and the relay is told to
 * confirm once the user is back. With the mock provider the relay settles it
 * immediately and there is nothing to open.
 */
async function startPayment(request) {
  let res;
  try {
    res = await api.payCreate(request);
  } catch (err) {
    toast(err.message || 'Не удалось создать платёж');
    return null;
  }
  if (res.checkoutUrl) {
    await api.openExternal(res.checkoutUrl);
    // Remember what is being paid for. The confirmation runs when the window
    // next has focus — the moment the user is back from the browser.
    state.wallet.pending = res.id;
    toast('Оплатите в открывшемся окне и вернитесь сюда', 6000);
    return res.id;
  }
  applyWallet(res);
  toast(res.kind === 'premium' ? 'Premium активирован' : 'Ракеты зачислены');
  return res.id;
}

async function buyPremium() {
  if (!state.username) return;
  await startPayment({ kind: 'premium' });
}

async function buyBundle(rockets) {
  if (!state.username) return;
  await startPayment({ kind: 'rockets', rockets });
}

/**
 * Ask the relay to confirm a payment. The relay does not take "I paid" on
 * faith: it asks the adapter, and only a provider confirmation credits
 * anything, so calling this is harmless when the payment is not there yet.
 * Returns the wallet reply, or null when the relay could not be reached.
 */
async function claimPayment(id) {
  try {
    const res = await api.payClaim({ id });
    applyWallet(res);
    return res;
  } catch { return null; } // the relay also pushes the wallet when it settles
}

/**
 * Confirm whatever payment is outstanding, once, when the user comes back.
 * A single attempt per focus: the relay credits exactly once and the wallet
 * push covers the rest, so there is no need to poll.
 */
async function settlePendingPayment() {
  const id = state.wallet.pending;
  if (!id || !state.username) return;
  const res = await claimPayment(id);
  if (!res) return; // relay away: keep the id and try on the next focus
  state.wallet.pending = null;
  if (res.paymentStatus === 'paid') {
    toast('Оплата подтверждена');
  } else {
    toast('Оплата пока не подтверждена. Если вы только что заплатили, подождите минуту и вернитесь в это окно.', 8000);
  }
}

// The user went to the browser to pay and has come back. Checking on focus
// (and on regaining visibility) is enough for a flow a person drives by hand.
window.addEventListener('focus', settlePendingPayment);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) settlePendingPayment();
});

if (els.btnBuyPremium) els.btnBuyPremium.addEventListener('click', buyPremium);

/* ============================= БУРМАЛДА FM ============================= */
// A local station: the playlist is a JSON manifest beside the audio files, so
// nothing has to change in code when the user adds tracks. With no manifest the
// station is honestly empty rather than pretending to play.

async function loadFmStation() {
  const fm = state.fm;
  let res = null;
  try { res = await api.readMediaManifest('fm'); }
  catch { /* no manifest yet — the station is empty */ }
  const manifest = res && res.manifest;
  fm.dir = (res && res.dir) || null;
  fm.playlist = FM ? FM.buildPlaylist(manifest, 'assets/fm') : [];
  // Point each track at the writable media folder the main process reported.
  if (fm.dir) {
    for (const t of fm.playlist) {
      t.file = mediaUrl(fm.dir, t.file.replace(/^assets\/fm\//, ''));
      if (t.cover) t.cover = mediaUrl(fm.dir, t.cover.replace(/^assets\/fm\//, ''));
    }
  }
  if (fm.index >= fm.playlist.length) fm.index = fm.playlist.length ? 0 : -1;
  renderFm();
}

function fmCurrent() {
  const fm = state.fm;
  return fm.index >= 0 ? fm.playlist[fm.index] : null;
}

function renderFm() {
  const fm = state.fm;
  const track = fmCurrent();
  els.fmEmpty.hidden = fm.playlist.length > 0;
  els.fmListCount.textContent = FM ? FM.trackCountLabel(fm.playlist.length) : `${fm.playlist.length}`;
  els.btnFmPlay.querySelector('use').setAttribute('href', fm.playing ? '#i-pause' : '#i-play');
  els.btnFmShuffle.classList.toggle('off', !fm.shuffle);
  els.btnFmRepeat.classList.toggle('active', fm.mode !== 'off');
  els.btnFmRepeat.dataset.mode = fm.mode;

  if (track) {
    els.fmNowTitle.textContent = track.title;
    els.fmNowSub.textContent = track.artist;
    if (track.cover) els.fmArt.innerHTML = `<img src="${escapeHtml(track.cover)}" alt="" />`;
  } else {
    els.fmNowTitle.textContent = 'Тишина в эфире';
    els.fmNowSub.textContent = 'Добавьте треки, чтобы выйти в эфир';
  }

  els.fmList.replaceChildren();
  fm.playlist.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'fm-track' + (i === fm.index ? ' active' : '');
    li.innerHTML = `<span class="fm-track-num">${i === fm.index && fm.playing ? icon('i-pause') : i + 1}</span>` +
      `<span class="fm-track-meta"><span class="fm-track-title">${escapeHtml(t.title)}</span>` +
      `<span class="fm-track-artist">${escapeHtml(t.artist)}</span></span>` +
      (t.duration ? `<span class="fm-track-dur">${FM.formatTime(t.duration)}</span>` : '');
    li.addEventListener('click', () => playFmIndex(i));
    els.fmList.append(li);
  });
}

function ensureFmAudio() {
  const fm = state.fm;
  if (fm.audio) return fm.audio;
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.addEventListener('timeupdate', () => {
    if (!fm.audio || !fm.audio.duration) return;
    els.fmSeek.value = String((fm.audio.currentTime / fm.audio.duration) * 100);
    els.fmTime.textContent = FM.formatTime(fm.audio.currentTime);
    els.fmDur.textContent = FM.formatTime(fm.audio.duration);
  });
  audio.addEventListener('ended', () => fmAdvance(1));
  audio.addEventListener('error', () => { fm.playing = false; renderFm(); });
  fm.audio = audio;
  return audio;
}

function playFmIndex(i) {
  const fm = state.fm;
  if (i < 0 || i >= fm.playlist.length) return;
  fm.index = i;
  const track = fm.playlist[i];
  const audio = ensureFmAudio();
  audio.src = track.file;
  audio.play().then(() => { fm.playing = true; renderFm(); }).catch(() => { fm.playing = false; renderFm(); });
  renderFm();
}

function toggleFmPlay() {
  const fm = state.fm;
  if (!fm.playlist.length) { toast('Плейлист пуст'); return; }
  if (fm.index < 0) { playFmIndex(0); return; }
  const audio = ensureFmAudio();
  if (fm.playing) { audio.pause(); fm.playing = false; }
  else { audio.play().then(() => { fm.playing = true; }).catch(() => {}); }
  renderFm();
}

function fmAdvance(dir) {
  const fm = state.fm;
  if (!fm.playlist.length) return;
  const next = dir > 0
    ? FM.nextIndex(fm.playlist.length, fm.index, fm.mode, fm.shuffle)
    : FM.prevIndex(fm.playlist.length, fm.index, fm.mode, fm.shuffle);
  if (next < 0) { fm.playing = false; renderFm(); return; }
  playFmIndex(next);
}

function openFm() {
  els.fmOverlay.hidden = false;
  loadFmStation();
}
function closeFm() {
  els.fmOverlay.hidden = true;
  const fm = state.fm;
  if (fm.audio && fm.playing) { fm.audio.pause(); fm.playing = false; }
}

els.btnFmClose.addEventListener('click', closeFm);
els.fmOverlay.addEventListener('click', (e) => { if (e.target === els.fmOverlay) closeFm(); });
els.btnFmPlay.addEventListener('click', toggleFmPlay);
els.btnFmNext.addEventListener('click', () => fmAdvance(1));
els.btnFmPrev.addEventListener('click', () => fmAdvance(-1));
els.btnFmShuffle.addEventListener('click', () => { state.fm.shuffle = !state.fm.shuffle; renderFm(); });
els.btnFmRepeat.addEventListener('click', () => { state.fm.mode = FM.cycleMode(state.fm.mode); renderFm(); });
els.fmSeek.addEventListener('input', () => {
  const fm = state.fm;
  if (!fm.audio || !fm.audio.duration) return;
  fm.audio.currentTime = (Number(els.fmSeek.value) / 100) * fm.audio.duration;
});

/* -------------------------------- events -------------------------------- */
// Events that add, change or remove a message somewhere; they invalidate the
// cached global-search history slice.
const MESSAGE_EVENTS = new Set([
  'message', 'edited', 'deleted', 'scheduled.released',
  'group.message', 'group.edited', 'group.deleted',
  'channel.message', 'channel.edited', 'channel.deletedMessage'
]);

api.onEvent((evt) => {
  // Any event that can add or remove a message makes the cached global-search
  // slice stale, so drop it and let the next query re-fetch.
  if (MESSAGE_EVENTS.has(evt.type)) invalidateGlobalSearch();
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

    case 'dialog.streak':
      // The pair's flame moved. `peer` is the other person from this device's
      // point of view, so it maps straight onto the open chat and the list.
      setDialogStreak(evt.peer, { count: evt.count, active: evt.active });
      renderChatList();
      renderDialogStreak();
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

    case 'call.incoming': {
      onIncomingCall(evt);
      break;
    }

    case 'wallet':
      // The relay pushed a new balance or subscription state. This can arrive
      // from another device or after a provider confirmation, so it is the one
      // place that updates what the settings panes show.
      applyWallet(evt);
      break;

    case 'call.answered': {
      const call = state.call;
      if (!call || evt.callId !== call.callId) break;
      // This peer picked up: build the leg and let negotiation begin. Any
      // signals that raced ahead of the answer are flushed now.
      const peer = evt.from;
      call.names = [...new Set([...call.names, peer])];
      peerConnectionFor(peer, { initiator: true });
      flushPendingSignals(peer);
      renderCall();
      break;
    }

    case 'call.signal': {
      onCallSignal(evt);
      break;
    }

    case 'call.declined': {
      const call = state.call;
      if (!call || evt.callId !== call.callId) break;
      endCallLocal('Звонок отклонён');
      break;
    }

    case 'call.ended': {
      const call = state.call;
      if (!call || evt.callId !== call.callId) break;
      endCallLocal('Собеседник завершил звонок');
      break;
    }

    case 'call.left': {
      const call = state.call;
      if (!call || evt.callId !== call.callId) break;
      const leg = call.peers.get(evt.from);
      if (leg) { try { leg.pc.close(); } catch { /* gone */ } call.peers.delete(evt.from); }
      removeVideoTile(evt.from);
      call.names = call.names.filter((n) => n !== evt.from);
      renderCall();
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
      if (gameEndOf({ text: evt.text })) {
        // The peer dismissed the board; drop ours too and keep the notice out of
        // the transcript. It is a control message, not something either said.
        endPeerGame(chat);
        break;
      }
      const m = {
        id: evt.id, text: evt.text, ts: evt.ts, mine: evt.kind === 'system:series' ? false : evt.from === state.username, from: evt.from,
        replyTo: evt.replyTo || null, reactions: [],
        kind: evt.kind || null, attachment: evt.attachment || null,
        expiresAt: evt.expiresAt || null
      };
      if (m.replyTo) {
        const orig = findMessage(m.replyTo);
        if (orig) m.quote = { from: orig.mine ? state.username : evt.from, text: orig.text, mine: orig.mine };
      }
      chat.messages.push(m);
      // The series note is a marker, not a message: it must not become the chat
      // preview or raise an unread badge.
      if (m.kind !== 'system:series') {
        chat.last = previewOf(m);
        chat.lastTs = evt.ts;
      }
      if (state.activePeer === key) {
        // A single live message lands at the end, so append it directly and
        // fall back to a rebuild only when the list is filtered. A vote is not
        // a bubble of its own; it just re-tallies the poll it points at.
        if (pollVoteOf(m)) renderMessagesImmediate();
        else if (!appendMessageEl(m)) renderMessages();
        updatePinnedBar();
        api.markRead(peerUsername(key)).catch(() => {});
      } else if (m.kind !== 'system:series') {
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

    case 'chat.ttl': {
      // The peer changed the conversation's auto-delete timer. `peer` is the
      // other person from this device's point of view.
      const key = chatKey(evt.peer);
      const chat = state.chats.get(key);
      if (chat) chat.ttl = evt.ttl || 0;
      if (state.activePeer === key) renderTtlChip();
      break;
    }

    case 'expired': {
      // A self-destructing message reached the end of its timer on the relay.
      for (const [key, chat] of state.chats) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) {
          m.deleted = true; m.text = ''; m.reactions = []; m.expiresAt = null;
          m.attachment = null; m.kind = null;
          if (state.activePeer === key) renderMessages();
          break;
        }
      }
      renderChatList();
      break;
    }

    case 'scheduled.new': {
      // Another one of this account's devices scheduled a message; keep the
      // shared list in step without a reload.
      const item = evt.item;
      if (item && !state.scheduled.some((x) => x.id === item.id)) {
        state.scheduled.push({ ...item, text: '' });
        state.scheduled.sort((a, b) => a.sendAt - b.sendAt);
        setScheduledBadge();
        if (!els.schedBackdrop.hidden) renderScheduledList();
      }
      break;
    }

    case 'scheduled.released': {
      // A scheduled message left the queue and became a real message. The
      // `message` frame that follows will add the bubble itself.
      state.scheduled = state.scheduled.filter((x) => x.id !== evt.id);
      setScheduledBadge();
      if (!els.schedBackdrop.hidden) renderScheduledList();
      break;
    }

    case 'scheduled.cancelled': {
      state.scheduled = state.scheduled.filter((x) => x.id !== evt.id);
      setScheduledBadge();
      if (!els.schedBackdrop.hidden) renderScheduledList();
      break;
    }

    case 'scheduled.rescheduled': {
      const item = state.scheduled.find((x) => x.id === evt.id);
      if (item) item.sendAt = evt.sendAt;
      state.scheduled.sort((a, b) => a.sendAt - b.sendAt);
      if (!els.schedBackdrop.hidden) renderScheduledList();
      break;
    }

    case 'deleted': {
      for (const [key, chat] of state.chats) {
        const m = chat.messages.find((x) => x.id === evt.id);
        if (m) { m.deleted = true; m.text = ''; m.reactions = []; m.expiresAt = null; if (state.activePeer === key) renderMessages(); break; }
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

    case 'story.new':
      handleStoryNew(evt);
      break;

    case 'story.views':
      updateStoryViews(evt.id, evt.count);
      break;

    case 'story.deleted':
      handleStoryDeleted(evt.id);
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
    previewUrl: att.preview || null,
    expiresAt: chat.ttl ? Date.now() + chat.ttl : null
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
            attachment: { kind: att.kind, bytes: att.bytes, name: att.name, mime: att.mime, duration: att.duration },
            ttl: chat.ttl || undefined
          });
    optimistic.id = res.id;
    if (res.expiresAt) optimistic.expiresAt = res.expiresAt;
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

/** Open the game picker under the composer, the way a hidden bot offers games. */
function openGamesPanel() {
  els.attachBackdrop.hidden = true;
  els.emojiPanel.hidden = false;
  setPanelMode('games');
  els.composerInput.focus();
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
  if (kind === 'schedule') { startScheduling(); return; }
  const file = await pickFile(kind === 'image' ? 'image/*' : undefined);
  if (file) await attachFile(kind === 'image' ? 'image' : 'file', file);
});

/** Open the "send later" picker for what is currently in the composer. */
function startScheduling() {
  const key = state.activePeer;
  if (!key) { toast(i18n.t('Откройте чат, чтобы отложить сообщение')); return; }
  if (isMultiKey(key) || isBotKey(key)) {
    toast(i18n.t('Отложенная отправка доступна в личных чатах'));
    return;
  }
  const text = els.composerInput.value.trim();
  if (!text) { toast(i18n.t('Сначала напишите сообщение')); return; }
  const replyTo = state.replyTo;
  openSchedulePicker({
    to: peerUsername(key), text,
    replyTo: replyTo ? replyTo.id : undefined,
    ttl: (activeChat().ttl || undefined)
  });
}

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
/** The payload tag a message carries, for the search classifier. */
function searchExtraOf(m) {
  if (pollPayloadOf(m)) return 'poll';
  if (giftPayloadOf(m)) return 'gift';
  if (gamePayloadOf(m)) return 'game';
  return null;
}

function openChatSearch() {
  els.chatSearchBar.hidden = false;
  els.chatSearchInput.focus();
  els.chatSearchInput.select();
}

function closeChatSearch() {
  els.chatSearchBar.hidden = true;
  els.chatSearchFilters.hidden = true;
  els.chatSearchInput.value = '';
  els.chatSearchCount.textContent = '';
  state.searchQuery = '';
  state.searchHits = [];
  state.searchIndex = -1;
  state.searchFilter = { query: '', from: 'any', kind: 'any', date: 'any' };
  renderSearchFilters();
  // Immediate: the coalesced render waits on requestAnimationFrame, which is
  // throttled in a background window, so the highlight would linger.
  if (state.activePeer) renderMessagesImmediate();
}

/** The chip rows: message kind, sender, and date range. */
function renderSearchFilters() {
  const build = (host, options, field) => {
    if (!host) return;
    host.innerHTML = '';
    for (const opt of options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'csf-chip' + (state.searchFilter[field] === opt.value ? ' active' : '');
      chip.dataset.value = opt.value;
      chip.textContent = opt.label;
      chip.addEventListener('click', () => {
        state.searchFilter[field] = opt.value;
        renderSearchFilters();
        runChatSearch(els.chatSearchInput.value.trim());
      });
      host.appendChild(chip);
    }
  };
  build(els.csfKinds, [
    { value: 'any', label: 'Все' },
    { value: 'media', label: 'Медиа' },
    { value: 'photo', label: 'Фото' },
    { value: 'voice', label: 'Голосовые' },
    { value: 'file', label: 'Файлы' },
    { value: 'link', label: 'Ссылки' },
    { value: 'poll', label: 'Опросы' },
    { value: 'gift', label: 'Подарки' },
    { value: 'game', label: 'Игры' }
  ], 'kind');
  build(els.csfFrom, [
    { value: 'any', label: 'Все' },
    { value: 'me', label: 'Я' },
    { value: 'them', label: 'Собеседник' }
  ], 'from');
  build(els.csfDate, [
    { value: 'any', label: 'За всё время' },
    { value: 'today', label: 'Сегодня' },
    { value: 'week', label: 'Неделя' },
    { value: 'month', label: 'Месяц' }
  ], 'date');
  if (els.btnChatSearchFilter) {
    els.btnChatSearchFilter.classList.toggle('has-filter', activeFilterCount() > 0);
  }
}

/** How many chips differ from the default, shown on the filter button. */
function activeFilterCount() {
  const f = state.searchFilter;
  return (f.from !== 'any' ? 1 : 0) + (f.kind !== 'any' ? 1 : 0) + (f.date !== 'any' ? 1 : 0);
}

async function runChatSearch(query) {
  state.searchQuery = query;
  state.searchFilter.query = query;
  state.searchHits = [];
  state.searchIndex = -1;
  if (!state.activePeer) return;
  const chat = activeChat();
  // A filter with no words still searches, so "every photo" works with an
  // empty box. Only a fully empty filter clears the highlight.
  const filter = state.searchFilter;
  const nothingAsked = !filter.query && filter.from === 'any' && filter.kind === 'any' && filter.date === 'any';
  if (nothingAsked) {
    els.chatSearchCount.textContent = '';
    renderMessages();
    return;
  }
  // Search what is already loaded; pull more history so older matches appear.
  if (chat && !chat.loaded) {
    try {
      const items = await api.history({ with: peerUsername(state.activePeer), limit: 300 });
      chat.messages = resolveQuotes(items);
      chat.loaded = true;
    } catch { /* keep what we have */ }
  }
  const hits = CHATSEARCH.search(chat ? chat.messages : [], filter, searchExtraOf).map((m) => m.id);
  state.searchHits = hits;
  state.searchIndex = hits.length ? hits.length - 1 : -1;
  els.chatSearchCount.textContent = hits.length ? `${hits.length} найдено` : 'ничего';
  renderMessagesImmediate();
  if (hits.length) scrollToMessage(hits[state.searchIndex], { smooth: false });
}

let chatSearchTimer = null;
renderSearchFilters();
els.btnChatSearch.addEventListener('click', () => {
  if (els.chatSearchBar.hidden) openChatSearch(); else closeChatSearch();
});
els.btnChatSearchClose.addEventListener('click', closeChatSearch);
els.btnChatSearchFilter.addEventListener('click', () => {
  els.chatSearchFilters.hidden = !els.chatSearchFilters.hidden;
  if (!els.chatSearchFilters.hidden) renderSearchFilters();
});
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
  else if (action === 'scheduled') openScheduled();
  else if (action === 'folders') openFolders();
  else if (action === 'burmalda') openFm();
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

function giftById(id) {
  return giftCatalogue().find((g) => g.id === id) || GIFTS.find((g) => g.id === id) || null;
}

/**
 * The shelf to draw. The relay's catalogue wins once it has been fetched, so
 * the price shown is the price charged; GIFTS is only the offline fallback.
 */
function giftCatalogue() {
  const fromServer = state.wallet.gifts || {};
  const ids = Object.keys(fromServer);
  if (!ids.length) return GIFTS;
  return ids.map((id) => ({ id, ...fromServer[id] }));
}

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
  els.giftsNote.textContent = `Подарок для ${displayNameFor(key)} · ${state.wallet.balance} 🚀`;
  renderGiftShelf();
  els.giftsBackdrop.hidden = false;
}

function renderGiftShelf() {
  if (!els.giftsGrid) return;
  els.giftsGrid.innerHTML = '';
  const balance = state.wallet.balance;
  for (const gift of giftCatalogue()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gift-card' + (balance < gift.cost ? ' gift-card-locked' : '');
    card.dataset.gift = gift.id;
    card.innerHTML = `<span class="gift-emoji">${gift.emoji}</span>
      <span class="gift-name">${escapeHtml(gift.name)}</span>
      <span class="gift-cost">${gift.cost} 🚀</span>`;
    card.addEventListener('click', async () => {
      els.giftsBackdrop.hidden = true;
      await sendGift(gift);
    });
    els.giftsGrid.appendChild(card);
  }
}

async function sendGift(gift) {
  const key = state.activePeer;
  if (!key) return;
  const to = peerUsername(key);
  // The relay debits the Rockets first and only then is the message sent, so a
  // gift can never go out without being paid for. The relay also decides the
  // price, so a tampered shelf cannot buy a gift cheaply.
  let res;
  try {
    res = await api.giftSend({ to, gift: gift.id });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Недостаточно')) {
      toast(`Не хватает ракет: нужно ${gift.cost}, у вас ${state.wallet.balance}`);
    } else {
      toast(msg || 'Не удалось отправить подарок');
    }
    return;
  }
  state.wallet.balance = res.balance;
  renderWallet();

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
    const sent = await api.send({ to, text: payload });
    optimistic.id = sent.id;
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
  state.stories = [];
  state.storiesSeen.clear();
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

/* ------------------------------ stories ------------------------------ */
// A story is a 24-hour post shared with the account's contacts and peers. The
// body travels as an ordinary end-to-end encrypted envelope, one copy per
// viewer, so the relay stores ciphertext and never learns the caption or the
// picture. This module owns the bar, the composer and the full-screen viewer.

const STORY_BGS = ['mint', 'sky', 'violet', 'amber', 'rose', 'lime', 'cyan', 'coral'];
const STORY_TTL_MS = 8000; // how long one story stays on screen before advancing

async function loadStories() {
  if (!STORIES) return;
  try {
    const items = await api.listStories();
    state.stories = items;
    for (const s of items) if (s.seen) state.storiesSeen.add(s.id);
    renderStoriesBar();
  } catch { /* offline: keep whatever we have */ }
}

function handleStoryNew(evt) {
  // A fresh story has no body until it is fetched; keep a light stub so the bar
  // shows the ring at once, then refresh to decrypt.
  if (!state.stories.some((s) => s.id === evt.id)) {
    state.stories.unshift({
      id: evt.id, author: evt.author, text: '', ts: evt.ts, expiresAt: evt.expiresAt,
      kind: evt.kind || null, attachment: null, seen: false, views: 0,
      mine: evt.author === state.username
    });
  }
  renderStoriesBar();
  loadStories();
  if (evt.author !== state.username) toast(`Новая история от ${displayNameFor(evt.author)}`);
}

function handleStoryDeleted(id) {
  state.stories = state.stories.filter((s) => s.id !== id);
  state.storiesSeen.delete(id);
  if (state.storyViewer && !els.storyViewer.hidden) {
    const current = currentStory();
    if (current && current.id === id) closeStoryViewer();
  }
  renderStoriesBar();
}

function updateStoryViews(id, count) {
  const s = state.stories.find((x) => x.id === id);
  if (s) s.views = count;
  if (state.storyViewer && !els.storyViewer.hidden) paintStoryViews();
}

/** The active stories grouped by author, in bar order. */
function storyGroups() {
  const groups = STORIES.byAuthor(state.stories, Date.now());
  const order = STORIES.orderAuthors(groups, {
    me: state.username,
    unseen: (_name, s) => !state.storiesSeen.has(s.id)
  });
  return { groups, order };
}

function renderStoriesBar() {
  if (!STORIES || !els.storiesBar) return;
  const { groups, order } = storyGroups();
  const mine = groups.get(state.username) || [];
  // The bar stays visible whenever the account is signed in: the "my story"
  // button is how a person adds one, and it must be reachable before the first
  // story exists.
  els.storiesBar.hidden = !state.username;

  paintAvatar(els.storyAddAvatar, state.username);
  const mineUnseen = STORIES.unseenCount(mine, state.storiesSeen);
  els.storyAdd.classList.toggle('has-stories', mine.length > 0);
  els.storyAdd.title = mine.length
    ? (mineUnseen ? `${i18n.t('My story')} · ${newCount(mineUnseen)}` : i18n.t('My story'))
    : i18n.t('Add story');

  els.storyRingList.innerHTML = '';
  for (const author of order) {
    if (author === state.username) continue;
    const list = groups.get(author) || [];
    if (!list.length) continue;
    const unseen = STORIES.unseenCount(list, state.storiesSeen);
    const li = document.createElement('li');
    li.className = 'story-ring ' + (unseen ? 'unseen' : 'seen');
    const ring = document.createElement('button');
    ring.className = 'story-ring-btn';
    ring.title = displayNameFor(author) + (unseen ? ` · ${newCount(unseen)}` : '');
    ring.innerHTML = `
      <span class="avatar story-ring-avatar" data-color="${escapeHtml(avatarColorFor(author))}">${avatarInnerHtml(author)}</span>
      <span class="story-name">${escapeHtml(displayNameFor(author))}</span>`;
    ring.addEventListener('click', () => openStoryViewer(author));
    li.appendChild(ring);
    els.storyRingList.appendChild(li);
  }
}

els.storyAdd.addEventListener('click', (e) => {
  const mine = storyGroups().groups.get(state.username) || [];
  // A plain tap reopens your own story when you have one; shift-click or an
  // empty ring opens the composer to add a new one.
  if (mine.length && !e.shiftKey) {
    openStoryViewer(state.username);
    return;
  }
  openStoryComposer();
});

/* ------------------------------ composer ------------------------------ */
function openStoryComposer() {
  if (!STORIES) return;
  state.storyDraft = { cap: '', kind: 'text', bg: 'mint', ttl: STORIES.DEFAULT_TTL_MS, attachment: null };
  els.storyCaption.value = '';
  els.storyTtl.value = String(STORIES.DEFAULT_TTL_MS);
  els.storyError.hidden = true;
  renderStoryBgRow();
  paintStoryPreview();
  els.storyBackdrop.hidden = false;
  els.storyCaption.focus();
  updateStoryAudienceNote();
}

function renderStoryBgRow() {
  els.storyBgRow.innerHTML = '';
  for (const bg of STORY_BGS) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'story-bg-dot' + (bg === state.storyDraft.bg ? ' active' : '');
    dot.dataset.bg = bg;
    dot.title = bg;
    dot.addEventListener('click', () => {
      state.storyDraft.bg = bg;
      renderStoryBgRow();
      paintStoryPreview();
    });
    els.storyBgRow.appendChild(dot);
  }
}

function paintStoryPreview() {
  const d = state.storyDraft;
  els.storyPreview.dataset.bg = d.bg;
  if (d.attachment && d.attachment.preview) {
    els.storyPreview.style.backgroundImage = `url(${d.attachment.preview})`;
    els.storyPreview.style.backgroundSize = 'cover';
    els.storyPreview.style.backgroundPosition = 'center';
    els.storyPreviewText.textContent = '';
  } else {
    els.storyPreview.style.backgroundImage = '';
    els.storyPreviewText.textContent = d.cap || 'Текст истории…';
  }
}

async function updateStoryAudienceNote() {
  try {
    const audience = await api.storyAudience();
    els.storyAudienceNote.textContent = audience.length
      ? `${i18n.t('Seen by')} ${audience.length} ${plural(audience.length, 'контакт', 'контакта', 'контактов')}.`
      : i18n.t('No one to show yet — message someone and they will appear here.');
  } catch {
    els.storyAudienceNote.textContent = i18n.t('Seen by your contacts.');
  }
}

els.storyCaption.addEventListener('input', () => {
  state.storyDraft.cap = els.storyCaption.value;
  paintStoryPreview();
});

els.storyTtl.addEventListener('change', () => {
  state.storyDraft.ttl = Number(els.storyTtl.value) || STORIES.DEFAULT_TTL_MS;
});

els.btnStoryPhoto.addEventListener('click', async () => {
  const file = await pickFile('image/*');
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    els.storyError.textContent = i18n.t("Too large — the limit is {size}", { size: humanSize(MAX_ATTACHMENT_BYTES) });
    els.storyError.hidden = false;
    return;
  }
  try {
    const bytes = await fileToBase64Bytes(file);
    state.storyDraft.kind = 'image';
    state.storyDraft.attachment = {
      kind: 'image', bytes, name: file.name || 'story.png',
      mime: file.type || 'image/png', preview: URL.createObjectURL(file)
    };
    paintStoryPreview();
  } catch (err) {
    els.storyError.textContent = err.message || i18n.t('Could not read the file');
    els.storyError.hidden = false;
  }
});

async function publishStory() {
  const draft = state.storyDraft;
  if (!draft) return;
  const hasImage = !!(draft.attachment && draft.attachment.bytes);
  if (!draft.cap.trim() && !hasImage) {
    els.storyError.textContent = i18n.t('Add a caption or a photo');
    els.storyError.hidden = false;
    return;
  }
  els.btnStoryPublish.disabled = true;
  try {
    const audience = await api.storyAudience();
    const body = STORIES.encode({ cap: draft.cap, kind: draft.kind, bg: draft.bg, ttl: draft.ttl });
    const res = await api.postStory({
      text: body, audience, ttl: draft.ttl,
      attachment: hasImage
        ? { kind: 'image', bytes: draft.attachment.bytes, name: draft.attachment.name, mime: draft.attachment.mime }
        : undefined
    });
    els.storyBackdrop.hidden = true;
    state.storyDraft = null;
    toast(i18n.t('Story published for 24 hours'));
    await loadStories();
    if (res && res.id) openStoryViewer(state.username);
  } catch (err) {
    els.storyError.textContent = err.message || 'Не удалось опубликовать';
    els.storyError.hidden = false;
  } finally {
    els.btnStoryPublish.disabled = false;
  }
}

els.btnStoryPublish.addEventListener('click', publishStory);
els.btnStoryClose.addEventListener('click', () => { els.storyBackdrop.hidden = true; });
els.storyBackdrop.addEventListener('click', (e) => {
  if (e.target === els.storyBackdrop) els.storyBackdrop.hidden = true;
});

/* ------------------------------- viewer ------------------------------- */
function currentStory() {
  const list = storyGroups().groups.get(state.storyGroup) || [];
  return list[state.storyIndex] || null;
}

function openStoryViewer(author) {
  const { groups, order } = storyGroups();
  const list = groups.get(author) || [];
  if (!list.length) return;
  state.storyGroup = author;
  state.storyOrder = order;
  // Start at the first story this device has not opened yet, if any.
  const firstUnseen = list.findIndex((s) => !state.storiesSeen.has(s.id));
  state.storyIndex = firstUnseen >= 0 ? firstUnseen : 0;
  els.storyViewer.hidden = false;
  paintStory();
}

function closeStoryViewer() {
  els.storyViewer.hidden = true;
  state.storyGroup = null;
  state.storyIndex = 0;
  clearTimeout(state.storyTimer);
  state.storyTimer = null;
}

async function paintStory() {
  const story = currentStory();
  if (!story) { closeStoryViewer(); return; }
  const list = storyGroups().groups.get(state.storyGroup) || [];

  els.storyViewerName.textContent = displayNameFor(story.author);
  paintAvatar(els.storyViewerAvatar, story.author);
  els.storyViewerTime.textContent = STORIES.remainingLabel(STORIES.remainingMs(story, Date.now())) + ' осталось';

  // Progress segments: one per story by this author, the current one filling.
  els.storyProgress.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    const seg = document.createElement('div');
    seg.className = 'story-progress-seg' + (i < state.storyIndex ? ' done' : '');
    if (i === state.storyIndex) {
      const fill = document.createElement('div');
      fill.className = 'story-progress-fill';
      seg.appendChild(fill);
      requestAnimationFrame(() => { fill.style.transition = `width ${STORY_TTL_MS}ms linear`; fill.style.width = '100%'; });
    }
    els.storyProgress.appendChild(seg);
  }

  // Body: a decoded text card, or the decrypted picture when there is one.
  const body = STORIES.decode(story.text) || { cap: story.text || '', kind: story.kind || 'text', bg: 'mint' };
  els.storyViewerImage.hidden = true;
  els.storyViewerImage.removeAttribute('src');
  els.storyViewerCard.hidden = false;
  els.storyViewerCard.dataset.bg = body.bg || 'mint';
  els.storyViewerText.textContent = body.cap || '';

  if (story.kind === 'image' && story.attachment) {
    els.storyViewerCard.hidden = true;
    try {
      const opened = await api.openStoryAttachment({ id: story.id });
      els.storyViewerImage.src = opened.dataUrl;
      els.storyViewerImage.hidden = false;
    } catch {
      els.storyViewerCard.hidden = false;
      els.storyViewerText.textContent = '⚠ Не удалось открыть фото';
    }
  }

  els.btnStoryDelete.hidden = story.author !== state.username;
  paintStoryViews();

  // Mark seen locally and on the relay (the author only learns a count).
  if (!state.storiesSeen.has(story.id) && story.author !== state.username) {
    state.storiesSeen.add(story.id);
    story.seen = true;
    api.viewStory({ id: story.id }).catch(() => {});
    renderStoriesBar();
  }

  clearTimeout(state.storyTimer);
  state.storyTimer = setTimeout(nextStory, STORY_TTL_MS);
}

function paintStoryViews() {
  const story = currentStory();
  if (!story) return;
  if (story.author === state.username) {
    els.storyViewerViews.textContent = story.views
      ? `${story.views} ${storyWord('views', story.views)}`
      : i18n.t('No views yet');
  } else {
    els.storyViewerViews.textContent = '';
  }
}

function nextStory() {
  const list = storyGroups().groups.get(state.storyGroup) || [];
  if (state.storyIndex + 1 < list.length) {
    state.storyIndex += 1;
    paintStory();
    return;
  }
  // End of this author: move to the next author with something unseen.
  const order = state.storyOrder;
  const at = order.indexOf(state.storyGroup);
  for (let i = at + 1; i < order.length; i++) {
    const next = order[i];
    const group = storyGroups().groups.get(next) || [];
    if (!group.length) continue;
    state.storyGroup = next;
    state.storyIndex = Math.max(0, group.findIndex((s) => !state.storiesSeen.has(s.id)));
    paintStory();
    return;
  }
  closeStoryViewer();
}

function prevStory() {
  if (state.storyIndex > 0) {
    state.storyIndex -= 1;
    paintStory();
    return;
  }
  const order = state.storyOrder;
  const at = order.indexOf(state.storyGroup);
  for (let i = at - 1; i >= 0; i--) {
    const prev = order[i];
    const group = storyGroups().groups.get(prev) || [];
    if (!group.length) continue;
    state.storyGroup = prev;
    state.storyIndex = group.length - 1;
    paintStory();
    return;
  }
}

els.btnStoryNext.addEventListener('click', nextStory);
els.btnStoryPrev.addEventListener('click', prevStory);
els.btnStoryViewerClose.addEventListener('click', closeStoryViewer);

els.btnStoryDelete.addEventListener('click', async () => {
  const story = currentStory();
  if (!story || story.author !== state.username) return;
  try {
    await api.deleteStory({ id: story.id });
    handleStoryDeleted(story.id);
  } catch (err) {
    toast(err.message || i18n.t('Could not delete the story'));
  }
});

document.addEventListener('keydown', (e) => {
  if (els.storyViewer.hidden) return;
  if (e.key === 'Escape') closeStoryViewer();
  else if (e.key === 'ArrowRight') nextStory();
  else if (e.key === 'ArrowLeft') prevStory();
});

/* --------------------------------- boot --------------------------------- */
(async function boot() {
  showAuthHome();
  buildEmojiPanel();
  buildStickerPanel();
  loadAppearance();
  // A single low-frequency ticker repaints the countdown on self-destructing
  // bubbles; the relay still decides when they actually vanish.
  setInterval(tickTtlMarks, 1000);
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
