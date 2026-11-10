'use strict';

/**
 * SleePhy mini-games: the rules for tic-tac-toe, draughts, chess and
 * battleship, plus a simple opponent for each.
 *
 * Pure logic only — no DOM, no network, no crypto. That keeps it testable with
 * plain `node` (see test/games.js) and keeps the relay out of it entirely: a
 * game move travels as an ordinary end-to-end encrypted message, so the server
 * sees only ciphertext, exactly like any other message.
 *
 * Each game exposes the same small surface:
 *   create()            -> the starting position (plain JSON)
 *   moves(state)        -> the legal moves for the side to move
 *   apply(state, move)  -> the next position (does not mutate the input)
 *   result(state)       -> null while playing, else { winner, reason }
 *   bot(state, level)   -> a legal move for the side to move
 *
 * `winner` is 0 or 1 for the two seats, or -1 for a draw.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SleePhyGames = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const clone = (value) => JSON.parse(JSON.stringify(value));

  /* ============================== tic-tac-toe ============================== */

  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  function tttWinner(cells) {
    for (const [a, b, c] of LINES) {
      if (cells[a] != null && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
    }
    return cells.includes(null) ? null : -1;
  }

  const ticTacToe = {
    id: 'tictactoe',
    name: 'Крестики-нолики',
    // Player 0 is ✕, player 1 is ◯. Seat 0 always moves first.
    create() { return { cells: Array(9).fill(null), turn: 0 }; },
    moves(state) {
      if (tttWinner(state.cells) != null) return [];
      const out = [];
      for (let i = 0; i < 9; i++) if (state.cells[i] == null) out.push(i);
      return out;
    },
    apply(state, move) {
      const next = clone(state);
      next.cells[move] = next.turn;
      next.turn = 1 - next.turn;
      return next;
    },
    result(state) {
      const w = tttWinner(state.cells);
      if (w == null) return null;
      return { winner: w, reason: w === -1 ? 'ничья' : 'три в ряд' };
    },
    bot(state, level = 2) {
      const me = state.turn;
      const free = ticTacToe.moves(state);
      if (!free.length) return null;
      if (level <= 1) return free[Math.floor(Math.random() * free.length)];
      // Perfect play: minimax with a depth bonus so a fast win is preferred.
      let best = free[0], bestScore = -Infinity;
      for (const move of free) {
        const score = -tttNegamax(ticTacToe.apply(state, move), 1 - me);
        if (score > bestScore) { bestScore = score; best = move; }
      }
      return best;
    }
  };

  function tttNegamax(state, me) {
    const w = tttWinner(state.cells);
    if (w != null) {
      if (w === -1) return 0;
      return w === me ? 10 - state.cells.filter((c) => c != null).length : -10 + state.cells.filter((c) => c != null).length;
    }
    let best = -Infinity;
    for (const move of ticTacToe.moves(state)) {
      const score = -tttNegamax(ticTacToe.apply(state, move), 1 - me);
      if (score > best) best = score;
    }
    return best;
  }

  /* =============================== draughts =============================== */
  // English draughts on an 8x8 board. Cell values:
  //   0 empty, 1 white man, 2 white king, 3 black man, 4 black king
  // White (seat 0) moves toward row 0; black (seat 1) toward row 7. Men capture
  // forward only, kings any direction, captures are mandatory.

  const D = { EMPTY: 0, WM: 1, WK: 2, BM: 3, BK: 4 };

  function draughtsStart() {
    const board = Array.from({ length: 8 }, () => Array(8).fill(0));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r][c] = D.BM;
    }
    for (let r = 5; r < 8; r++) {
      for (let c = 0; c < 8; c++) if ((r + c) % 2 === 1) board[r][c] = D.WM;
    }
    return { board, turn: 0 };
  }

  const inBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const isWhite = (v) => v === D.WM || v === D.WK;
  const isBlack = (v) => v === D.BM || v === D.BK;
  const own = (v, player) => (player === 0 ? isWhite(v) : isBlack(v));
  const enemy = (v, player) => (player === 0 ? isBlack(v) : isWhite(v));

  function draughtsDirections(v) {
    if (v === D.WK || v === D.BK) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    if (v === D.WM) return [[-1, -1], [-1, 1]];
    return [[1, -1], [1, 1]];
  }

  // Collect every jump sequence for one piece. `captured` guards against
  // re-jumping the same man; a sequence ends when no further jump exists.
  function draughtsJumpsFrom(board, r, c, player, captured, acc, out) {
    const v = board[r][c];
    let extended = false;
    for (const [dr, dc] of draughtsDirections(v)) {
      const mr = r + dr, mc = c + dc, tr = r + 2 * dr, tc = c + 2 * dc;
      if (!inBoard(tr, tc)) continue;
      const mid = board[mr][mc];
      if (!enemy(mid, player)) continue;
      if (captured.has(mr + ',' + mc)) continue;
      if (board[tr][tc] !== 0) continue;
      extended = true;
      captured.add(mr + ',' + mc);
      acc.push([tr, tc]);
      draughtsJumpsFrom(board, tr, tc, player, captured, acc, out);
      acc.pop();
      captured.delete(mr + ',' + mc);
    }
    if (!extended && acc.length) {
      out.push({ from: acc.start, to: acc[acc.length - 1], path: acc.slice(), captures: null });
    }
  }

  function draughtsMoves(state) {
    const { board, turn } = state;
    const jumps = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const v = board[r][c];
        if (!own(v, turn)) continue;
        const out = [];
        const acc = [];
        acc.start = [r, c];
        draughtsJumpsFrom(board, r, c, turn, new Set(), acc, out);
        for (const j of out) {
          // The captured men are the squares the path skips over.
          const caps = [];
          let prev = [r, c];
          for (const step of j.path) {
            caps.push([(prev[0] + step[0]) / 2, (prev[1] + step[1]) / 2]);
            prev = step;
          }
          jumps.push({ from: [r, c], to: j.to, path: j.path, captures: caps });
        }
      }
    }
    if (jumps.length) return jumps;
    const quiet = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const v = board[r][c];
        if (!own(v, turn)) continue;
        for (const [dr, dc] of draughtsDirections(v)) {
          const tr = r + dr, tc = c + dc;
          if (inBoard(tr, tc) && board[tr][tc] === 0) {
            quiet.push({ from: [r, c], to: [tr, tc], path: [[tr, tc]], captures: [] });
          }
        }
      }
    }
    return quiet;
  }

  function draughtsApply(state, move) {
    const next = clone(state);
    const board = next.board;
    let [r, c] = move.from;
    const v = board[r][c];
    board[r][c] = 0;
    for (const [cr, cc] of (move.captures || [])) board[cr][cc] = 0;
    let [tr, tc] = move.to;
    // Promotion: a man landing on its far row becomes a king.
    let piece = v;
    if (v === D.WM && tr === 0) piece = D.WK;
    if (v === D.BM && tr === 7) piece = D.BK;
    board[tr][tc] = piece;
    next.turn = 1 - next.turn;
    return next;
  }

  function draughtsResult(state) {
    if (!draughtsMoves(state).length) {
      // The side to move has no move: it loses.
      return { winner: 1 - state.turn, reason: 'нет ходов' };
    }
    return null;
  }

  function draughtsMaterial(board, player) {
    let score = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const v = board[r][c];
        if (own(v, player)) score += (v === D.WK || v === D.BK) ? 3 : 1;
        else if (enemy(v, player)) score -= (v === D.WK || v === D.BK) ? 3 : 1;
      }
    }
    return score;
  }

  const checkers = {
    id: 'checkers',
    name: 'Шашки',
    create: draughtsStart,
    moves: draughtsMoves,
    apply: draughtsApply,
    result: draughtsResult,
    bot(state, level = 2) {
      const moves = draughtsMoves(state);
      if (!moves.length) return null;
      const depth = level <= 1 ? 1 : level === 2 ? 3 : 4;
      let best = moves[0], bestScore = -Infinity;
      for (const move of moves) {
        const score = -draughtsNegamax(draughtsApply(state, move), 1 - state.turn, depth - 1);
        if (score > bestScore) { bestScore = score; best = move; }
      }
      return best;
    }
  };

  function draughtsNegamax(state, me, depth) {
    const res = draughtsResult(state);
    if (res) return res.winner === me ? 1000 + depth : -1000 - depth;
    if (depth <= 0) return draughtsMaterial(state.board, me) + (state.turn === me ? 0.1 : -0.1);
    let best = -Infinity;
    for (const move of draughtsMoves(state)) {
      const score = -draughtsNegamax(draughtsApply(state, move), 1 - me, depth - 1);
      if (score > best) best = score;
    }
    return best;
  }

  /* ================================ chess ================================= */
  // Pieces: uppercase white (seat 0), lowercase black (seat 1).
  // Board rows run 0 (rank 8) to 7 (rank 1); columns 0 (file a) to 7 (file h).
  // A move is { from:[r,c], to:[r,c], promo:'q'|'r'|'b'|'n' }.

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

  function chessFromFen(fen) {
    const board = Array.from({ length: 8 }, () => Array(8).fill(''));
    fen.split('/').forEach((row, r) => {
      let c = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) c += Number(ch);
        else board[r][c++] = ch;
      }
    });
    return {
      board,
      turn: 0,
      castling: { wk: true, wq: true, bk: true, bq: true },
      ep: null,
      halfmove: 0,
      fullmove: 1
    };
  }

  const white = (p) => p >= 'A' && p <= 'Z';
  const black = (p) => p >= 'a' && p <= 'z';
  const colorOf = (p) => (white(p) ? 0 : 1);
  const mine = (p, player) => (player === 0 ? white(p) : black(p));
  const theirs = (p, player) => (player === 0 ? black(p) : white(p));

  function chessPseudoMoves(state, player) {
    const { board } = state;
    const out = [];
    const push = (from, to, extra) => out.push(Object.assign({ from, to }, extra || {}));
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p || !mine(p, player)) continue;
        const kind = p.toLowerCase();
        if (kind === 'p') {
          const dir = player === 0 ? -1 : 1;
          const startRow = player === 0 ? 6 : 1;
          const promoRow = player === 0 ? 0 : 7;
          const one = r + dir;
          if (inBoard(one, c) && !board[one][c]) {
            if (one === promoRow) for (const q of 'qrbn') push([r, c], [one, c], { promo: q });
            else {
              push([r, c], [one, c]);
              const two = r + 2 * dir;
              if (r === startRow && !board[two][c]) push([r, c], [two, c]);
            }
          }
          for (const dc of [-1, 1]) {
            const tc = c + dc;
            if (!inBoard(one, tc)) continue;
            const t = board[one][tc];
            const isEp = state.ep && state.ep[0] === one && state.ep[1] === tc;
            if ((t && theirs(t, player)) || isEp) {
              if (one === promoRow) for (const q of 'qrbn') push([r, c], [one, tc], { promo: q });
              else push([r, c], [one, tc]);
            }
          }
        } else if (kind === 'n') {
          for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
            const tr = r + dr, tc = c + dc;
            if (inBoard(tr, tc) && !mine(board[tr][tc], player)) push([r, c], [tr, tc]);
          }
        } else if (kind === 'k') {
          for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
            const tr = r + dr, tc = c + dc;
            if (inBoard(tr, tc) && !mine(board[tr][tc], player)) push([r, c], [tr, tc]);
          }
          // Castling: rights intact, squares empty, and the king not in check.
          const homeRow = player === 0 ? 7 : 0;
          const king = player === 0 ? 'K' : 'k';
          const rook = player === 0 ? 'R' : 'r';
          if (r === homeRow && c === 4 && board[homeRow][4] === king) {
            const rights = player === 0 ? state.castling : { wk: state.castling.bk, wq: state.castling.bq };
            if (rights.wk && board[homeRow][5] === '' && board[homeRow][6] === '' && board[homeRow][7] === rook
              && !chessAttacked(state, homeRow, 4, player) && !chessAttacked(state, homeRow, 5, player) && !chessAttacked(state, homeRow, 6, player)) {
              push([r, c], [homeRow, 6], { castle: 'k' });
            }
            if (rights.wq && board[homeRow][3] === '' && board[homeRow][2] === '' && board[homeRow][1] === ''
              && board[homeRow][0] === rook
              && !chessAttacked(state, homeRow, 4, player) && !chessAttacked(state, homeRow, 3, player) && !chessAttacked(state, homeRow, 2, player)) {
              push([r, c], [homeRow, 2], { castle: 'q' });
            }
          }
        } else {
          const dirs = kind === 'r' ? [[-1, 0], [1, 0], [0, -1], [0, 1]]
            : kind === 'b' ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
              : [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
          for (const [dr, dc] of dirs) {
            let tr = r + dr, tc = c + dc;
            while (inBoard(tr, tc)) {
              const t = board[tr][tc];
              if (!t) push([r, c], [tr, tc]);
              else { if (theirs(t, player)) push([r, c], [tr, tc]); break; }
              tr += dr; tc += dc;
            }
          }
        }
      }
    }
    return out;
  }

  // Is square (r,c) attacked by `player`? Used for check and castling.
  function chessAttacked(state, r, c, player) {
    const { board } = state;
    for (let sr = 0; sr < 8; sr++) {
      for (let sc = 0; sc < 8; sc++) {
        const p = board[sr][sc];
        if (!p || !mine(p, player)) continue;
        const kind = p.toLowerCase();
        const dr = r - sr, dc = c - sc;
        if (kind === 'p') {
          const dir = player === 0 ? -1 : 1;
          if (dr === dir && Math.abs(dc) === 1) return true;
        } else if (kind === 'n') {
          if ((Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2)) return true;
        } else if (kind === 'k') {
          if (Math.max(Math.abs(dr), Math.abs(dc)) === 1) return true;
        } else {
          const diag = Math.abs(dr) === Math.abs(dc) && dr !== 0;
          const line = (dr === 0 || dc === 0) && !(dr === 0 && dc === 0);
          if ((kind === 'b' && !diag) || (kind === 'r' && !line) || (kind === 'q' && !diag && !line)) continue;
          const stepR = Math.sign(dr), stepC = Math.sign(dc);
          let tr = sr + stepR, tc = sc + stepC, blocked = false;
          while (tr !== r || tc !== c) {
            if (board[tr][tc]) { blocked = true; break; }
            tr += stepR; tc += stepC;
          }
          if (!blocked) return true;
        }
      }
    }
    return false;
  }

  function chessKingSquare(board, player) {
    const king = player === 0 ? 'K' : 'k';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === king) return [r, c];
    return null;
  }

  function chessApplyMove(state, move) {
    const next = clone(state);
    const board = next.board;
    const player = next.turn;
    const p = board[move.from[0]][move.from[1]];
    const target = board[move.to[0]][move.to[1]];
    board[move.from[0]][move.from[1]] = '';
    board[move.to[0]][move.to[1]] = move.promo && p.toLowerCase() === 'p'
      ? (player === 0 ? move.promo.toUpperCase() : move.promo)
      : p;
    // En passant capture removes the pawn that stepped past.
    if (p.toLowerCase() === 'p' && next.ep && move.to[0] === next.ep[0] && move.to[1] === next.ep[1] && !target) {
      board[move.from[0]][move.to[1]] = '';
    }
    // Castling moves the rook too.
    if (move.castle) {
      const homeRow = player === 0 ? 7 : 0;
      if (move.castle === 'k') { board[homeRow][5] = board[homeRow][7]; board[homeRow][7] = ''; }
      else { board[homeRow][3] = board[homeRow][0]; board[homeRow][0] = ''; }
    }
    // New en-passant square after a two-square pawn push.
    next.ep = null;
    if (p.toLowerCase() === 'p' && Math.abs(move.to[0] - move.from[0]) === 2) {
      next.ep = [(move.from[0] + move.to[0]) / 2, move.from[1]];
    }
    // Castling rights: a king move or a rook move from home clears them.
    const homeRow = player === 0 ? 7 : 0;
    if (p === 'K') { next.castling.wk = false; next.castling.wq = false; }
    if (p === 'k') { next.castling.bk = false; next.castling.bq = false; }
    if (p === 'R' && move.from[0] === homeRow && move.from[1] === 7) next.castling.wk = false;
    if (p === 'R' && move.from[0] === homeRow && move.from[1] === 0) next.castling.wq = false;
    if (p === 'r' && move.from[0] === 0 && move.from[1] === 7) next.castling.bk = false;
    if (p === 'r' && move.from[0] === 0 && move.from[1] === 0) next.castling.bq = false;
    // A rook captured on its home square also clears the right.
    if (move.to[0] === 7 && move.to[1] === 7) next.castling.wk = false;
    if (move.to[0] === 7 && move.to[1] === 0) next.castling.wq = false;
    if (move.to[0] === 0 && move.to[1] === 7) next.castling.bk = false;
    if (move.to[0] === 0 && move.to[1] === 0) next.castling.bq = false;
    next.turn = 1 - next.turn;
    return next;
  }

  function chessLegalMoves(state) {
    const player = state.turn;
    const out = [];
    for (const move of chessPseudoMoves(state, player)) {
      const after = chessApplyMove(state, move);
      const king = chessKingSquare(after.board, player);
      if (king && chessAttacked(after, king[0], king[1], 1 - player)) continue;
      out.push(move);
    }
    return out;
  }

  function chessInsufficient(board) {
    const pieces = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c]) pieces.push(board[r][c].toLowerCase());
    if (pieces.length <= 2) return true; // kings only
    if (pieces.length === 3 && (pieces.includes('n') || pieces.includes('b'))) return true;
    return false;
  }

  function chessResult(state) {
    if (!chessLegalMoves(state).length) {
      const king = chessKingSquare(state.board, state.turn);
      if (king && chessAttacked(state, king[0], king[1], 1 - state.turn)) {
        return { winner: 1 - state.turn, reason: 'мат' };
      }
      return { winner: -1, reason: 'пат' };
    }
    if (chessInsufficient(state.board)) return { winner: -1, reason: 'ничья' };
    return null;
  }

  const PIECE_VALUE = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 0 };

  function chessEval(board, player) {
    let score = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (!p) continue;
        const v = PIECE_VALUE[p.toLowerCase()] || 0;
        score += mine(p, player) ? v : -v;
      }
    }
    return score;
  }

  const chess = {
    id: 'chess',
    name: 'Шахматы',
    create: () => chessFromFen(START_FEN),
    moves: chessLegalMoves,
    apply: chessApplyMove,
    result: chessResult,
    bot(state, level = 2) {
      const moves = chessLegalMoves(state);
      if (!moves.length) return null;
      const depth = level <= 1 ? 1 : level === 2 ? 2 : 3;
      let best = moves[0], bestScore = -Infinity;
      for (const move of moves) {
        const score = -chessNegamax(chessApplyMove(state, move), 1 - state.turn, depth - 1, -Infinity, Infinity);
        if (score > bestScore) { bestScore = score; best = move; }
      }
      return best;
    }
  };

  function chessNegamax(state, me, depth, alpha, beta) {
    const res = chessResult(state);
    if (res) return res.winner === me ? 10000 + depth : res.winner === -1 ? 0 : -10000 - depth;
    if (depth <= 0) return chessEval(state.board, me);
    let best = -Infinity;
    for (const move of chessLegalMoves(state)) {
      const score = -chessNegamax(chessApplyMove(state, move), 1 - me, depth - 1, -beta, -alpha);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  /* ============================== battleship ============================== */
  // Two 10x10 grids. Each player hides a fleet; the opponent fires at squares.
  // Ships: sizes 4,3,3,2,2,2,1,1,1,1 in the classic Russian layout.

  const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const BS = 10;

  function bsEmptyGrid() { return Array.from({ length: BS }, () => Array(BS).fill(null)); }

  // Place the fleet without touching (ships may not share a side or corner).
  function bsPlaceFleet() {
    const grid = bsEmptyGrid();
    const ships = [];
    for (const size of FLEET) {
      let placed = false;
      for (let attempt = 0; attempt < 500 && !placed; attempt++) {
        const horiz = Math.random() < 0.5;
        const r = Math.floor(Math.random() * BS);
        const c = Math.floor(Math.random() * BS);
        const cells = [];
        let ok = true;
        for (let i = 0; i < size; i++) {
          const rr = horiz ? r : r + i;
          const cc = horiz ? c + i : c;
          if (!inBoard(rr, cc) || grid[rr][cc] != null) { ok = false; break; }
          cells.push([rr, cc]);
        }
        if (!ok) continue;
        // No touching, even diagonally.
        for (const [rr, cc] of cells) {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const nr = rr + dr, nc = cc + dc;
              if (inBoard(nr, nc) && grid[nr][nc] != null) ok = false;
            }
          }
        }
        if (!ok) continue;
        const id = ships.length;
        for (const [rr, cc] of cells) grid[rr][cc] = id;
        ships.push({ id, size, cells, hits: 0 });
        placed = true;
      }
      if (!placed) return null;
    }
    return { grid, ships };
  }

  function battleshipCreate() {
    let fleet;
    do { fleet = bsPlaceFleet(); } while (!fleet);
    return {
      fleets: [fleet, null],   // seat 1's fleet is filled in by the peer's message
      shots: [bsEmptyGrid(), bsEmptyGrid()], // shots[target] = squares the other seat fired
      turn: 0,
      ready: [true, false]
    };
  }

  function bsAllSunk(fleet) { return fleet.ships.every((s) => s.hits >= s.size); }

  function battleshipMoves(state) {
    if (battleshipResult(state)) return [];
    const target = 1 - state.turn;
    if (!state.fleets[target]) return [];
    const shots = state.shots[target];
    const out = [];
    for (let r = 0; r < BS; r++) for (let c = 0; c < BS; c++) if (shots[r][c] == null) out.push([r, c]);
    return out;
  }

  function battleshipApply(state, move) {
    const next = clone(state);
    const target = 1 - next.turn;
    const [r, c] = move;
    const grid = next.fleets[target].grid;
    const id = grid[r][c];
    next.shots[target][r][c] = id == null ? 'miss' : 'hit';
    if (id != null) next.fleets[target].ships[id].hits += 1;
    next.turn = 1 - next.turn;
    return next;
  }

  function battleshipResult(state) {
    for (const seat of [0, 1]) {
      const other = 1 - seat;
      if (state.fleets[seat] && bsAllSunk(state.fleets[seat])) {
        // The seat whose fleet is gone loses.
        return { winner: other, reason: 'флот уничтожен' };
      }
    }
    return null;
  }

  // Hunt/target: after a hit, try the neighbours before returning to hunting.
  function bsBotMove(state, level = 2) {
    const moves = battleshipMoves(state);
    if (!moves.length) return null;
    const target = 1 - state.turn;
    const shots = state.shots[target];
    const grid = state.fleets[target].grid;
    if (level >= 2) {
      const hits = [];
      for (let r = 0; r < BS; r++) for (let c = 0; c < BS; c++) if (shots[r][c] === 'hit') hits.push([r, c]);
      const candidates = [];
      for (const [r, c] of hits) {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
          if (inBoard(nr, nc) && shots[nr][nc] == null) candidates.push([nr, nc]);
        }
      }
      if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
    }
    // Hunt with a checkerboard bias so no ship of size >= 2 is missed.
    const parity = moves.filter(([r, c]) => (r + c) % 2 === 0);
    const pool = parity.length ? parity : moves;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const battleship = {
    id: 'battleship',
    name: 'Морской бой',
    create: battleshipCreate,
    moves: battleshipMoves,
    apply: battleshipApply,
    result: battleshipResult,
    bot: bsBotMove
  };

  /**
   * Place a fresh fleet for one seat. Battleship is the one game whose two
   * sides start from different positions (each hides a fleet), so a seat's
   * fleet is filled in by that seat — by the local device for its own seat, and
   * by the peer's first message for theirs.
   */
  function setFleet(state, seat) {
    const next = clone(state);
    let fleet;
    do { fleet = bsPlaceFleet(); } while (!fleet);
    next.fleets[seat] = fleet;
    next.ready[seat] = true;
    return next;
  }

  const GAMES = [ticTacToe, checkers, chess, battleship];
  const byId = (id) => GAMES.find((g) => g.id === id) || null;

  /* ============================== codecs ================================= */
  // A game position is serialised to a short ASCII string. It is small enough
  // to sit in the account's settings blob and to travel inside one encrypted
  // message when two people play, so a move never needs a new wire format.

  const TTT_CH = ['.', 'x', 'o'];
  const DR_CH = ['.', 'w', 'W', 'b', 'B'];

  function encode(gameId, state) {
    if (gameId === 'tictactoe') {
      return state.cells.map((c) => TTT_CH[c == null ? 0 : c + 1]).join('') + '|' + state.turn;
    }
    if (gameId === 'checkers') {
      return state.board.map((row) => row.map((v) => DR_CH[v]).join('')).join('') + '|' + state.turn;
    }
    if (gameId === 'chess') {
      const board = state.board.map((row) => row.map((p) => p || '.').join('')).join('');
      const rights = (state.castling.wk ? 'K' : '') + (state.castling.wq ? 'Q' : '')
        + (state.castling.bk ? 'k' : '') + (state.castling.bq ? 'q' : '') || '-';
      const ep = state.ep ? state.ep[0] + ',' + state.ep[1] : '-';
      return [board, rights, ep, state.turn].join('|');
    }
    if (gameId === 'battleship') {
      const gridStr = (fleet) => {
        if (!fleet) return '?'.repeat(BS * BS);
        let out = '';
        for (let r = 0; r < BS; r++) for (let c = 0; c < BS; c++) {
          const id = fleet.grid[r][c];
          out += id == null ? '.' : String.fromCharCode(65 + id);
        }
        return out;
      };
      const shotStr = (grid) => {
        let out = '';
        for (let r = 0; r < BS; r++) for (let c = 0; c < BS; c++) {
          const v = grid[r][c];
          out += v == null ? '.' : v === 'hit' ? 'h' : 'm';
        }
        return out;
      };
      return [
        gridStr(state.fleets[0]), gridStr(state.fleets[1]),
        shotStr(state.shots[0]), shotStr(state.shots[1]),
        state.turn, (state.ready[0] ? 1 : 0) + '' + (state.ready[1] ? 1 : 0)
      ].join('|');
    }
    throw new Error('unknown game ' + gameId);
  }

  function decode(gameId, str) {
    const parts = String(str).split('|');
    if (gameId === 'tictactoe') {
      const cells = [...parts[0]].map((ch) => (ch === 'x' ? 0 : ch === 'o' ? 1 : null));
      return { cells, turn: Number(parts[1]) || 0 };
    }
    if (gameId === 'checkers') {
      const board = [];
      for (let r = 0; r < 8; r++) {
        board.push([...parts[0].slice(r * 8, r * 8 + 8)].map((ch) => DR_CH.indexOf(ch)));
      }
      return { board, turn: Number(parts[1]) || 0 };
    }
    if (gameId === 'chess') {
      const flat = parts[0];
      const board = [];
      for (let r = 0; r < 8; r++) {
        board.push([...flat.slice(r * 8, r * 8 + 8)].map((ch) => (ch === '.' ? '' : ch)));
      }
      const rights = parts[1] || '-';
      const ep = parts[2] && parts[2] !== '-' ? parts[2].split(',').map(Number) : null;
      return {
        board,
        castling: {
          wk: rights.includes('K'), wq: rights.includes('Q'),
          bk: rights.includes('k'), bq: rights.includes('q')
        },
        ep, turn: Number(parts[3]) || 0, halfmove: 0, fullmove: 1
      };
    }
    if (gameId === 'battleship') {
      const readGrid = (s) => {
        if (s.startsWith('?')) return null;
        const grid = Array.from({ length: BS }, () => Array(BS).fill(null));
        for (let i = 0; i < BS * BS; i++) {
          const ch = s[i];
          grid[Math.floor(i / BS)][i % BS] = ch === '.' ? null : ch.charCodeAt(0) - 65;
        }
        return { grid, ships: [] };
      };
      const readShots = (s) => {
        const grid = Array.from({ length: BS }, () => Array(BS).fill(null));
        for (let i = 0; i < BS * BS; i++) {
          const ch = s[i];
          grid[Math.floor(i / BS)][i % BS] = ch === '.' ? null : ch === 'h' ? 'hit' : 'miss';
        }
        return grid;
      };
      const fleets = [readGrid(parts[0]), readGrid(parts[1])];
      const shots = [readShots(parts[2]), readShots(parts[3])];
      // Rebuild each ship's cell list and hit count from the grid and shots.
      for (let seat = 0; seat < 2; seat++) {
        const fleet = fleets[seat];
        if (!fleet) continue;
        const byId = new Map();
        for (let r = 0; r < BS; r++) for (let c = 0; c < BS; c++) {
          const id = fleet.grid[r][c];
          if (id == null) continue;
          if (!byId.has(id)) byId.set(id, []);
          byId.get(id).push([r, c]);
        }
        fleet.ships = [...byId.entries()].map(([id, cells]) => {
          const hits = cells.filter(([r, c]) => shots[seat][r][c] === 'hit').length;
          return { id, size: cells.length, cells, hits };
        }).sort((a, b) => a.id - b.id);
      }
      const ready = parts[5] || '10';
      return {
        fleets, shots,
        turn: Number(parts[4]) || 0,
        ready: [ready[0] === '1', ready[1] === '1']
      };
    }
    throw new Error('unknown game ' + gameId);
  }

  return { ticTacToe, checkers, chess, battleship, GAMES, byId, FLEET, BS, encode, decode, setFleet };
});
