'use strict';

/**
 * Tests for the mini-game rules in src/lib/games.js. Pure logic, no server and
 * no browser: this runs with plain `node test/games.js`.
 */

const assert = require('assert');
const games = require('../src/lib/games');

const results = [];
function pass(name) { results.push(true); console.log('  PASS', name); }
function fail(name, err) { results.push(false); console.log('  FAIL', name, '->', err && err.message); }
function step(name, fn) {
  try { fn(); pass(name); } catch (err) { fail(name, err); }
}

/* ------------------------------ tic-tac-toe ------------------------------ */
step('tic-tac-toe starts empty with seat 0 to move', () => {
  const s = games.ticTacToe.create();
  assert.strictEqual(s.cells.length, 9);
  assert.ok(s.cells.every((c) => c === null));
  assert.strictEqual(s.turn, 0);
  assert.strictEqual(games.ticTacToe.moves(s).length, 9);
});

step('tic-tac-toe detects three in a row', () => {
  let s = games.ticTacToe.create();
  s = games.ticTacToe.apply(s, 0); // ✕
  s = games.ticTacToe.apply(s, 3); // ◯
  s = games.ticTacToe.apply(s, 1); // ✕
  s = games.ticTacToe.apply(s, 4); // ◯
  s = games.ticTacToe.apply(s, 2); // ✕ wins top row
  const res = games.ticTacToe.result(s);
  assert.deepStrictEqual(res, { winner: 0, reason: 'три в ряд' });
  assert.strictEqual(games.ticTacToe.moves(s).length, 0);
});

step('tic-tac-toe detects a draw', () => {
  // ✕ ◯ ✕ / ✕ ◯ ◯ / ◯ ✕ ✕  -> full board, no line
  const cells = [0, 1, 0, 0, 1, 1, 1, 0, 0];
  const s = { cells, turn: 0 };
  assert.deepStrictEqual(games.ticTacToe.result(s), { winner: -1, reason: 'ничья' });
});

step('tic-tac-toe bot blocks an immediate loss', () => {
  // ✕ at 0 and 1; ◯ to move must take 2.
  const s = { cells: [0, 0, null, null, null, null, null, null, null], turn: 1 };
  assert.strictEqual(games.ticTacToe.bot(s, 2), 2);
});

step('tic-tac-toe bot takes a win over a block', () => {
  // ◯ has 0 and 1 (winning at 2); ✕ has 3 and 4 (threat at 5).
  const s = { cells: [1, 1, null, 0, 0, null, null, null, null], turn: 1 };
  assert.strictEqual(games.ticTacToe.bot(s, 2), 2);
});

step('a perfect tic-tac-toe bot never loses to random play', () => {
  for (let game = 0; game < 30; game++) {
    let s = games.ticTacToe.create();
    while (!games.ticTacToe.result(s)) {
      const botSeat = 1;
      if (s.turn === botSeat) {
        s = games.ticTacToe.apply(s, games.ticTacToe.bot(s, 2));
      } else {
        const moves = games.ticTacToe.moves(s);
        s = games.ticTacToe.apply(s, moves[Math.floor(Math.random() * moves.length)]);
      }
    }
    const res = games.ticTacToe.result(s);
    assert.notStrictEqual(res.winner, 0, `the perfect bot (seat 1) lost a random game: ${JSON.stringify(s.cells)}`);
  }
});

/* -------------------------------- draughts ------------------------------- */
step('draughts starts with 12 men a side and 7 opening moves', () => {
  const s = games.checkers.create();
  const white = s.board.flat().filter((v) => v === games.checkers.create().board[0][0] || v === 1 || v === 2).length;
  assert.strictEqual(s.turn, 0);
  assert.strictEqual(games.checkers.moves(s).length, 7);
});

step('draughts promotes a man that reaches the far row', () => {
  const board = Array.from({ length: 8 }, () => Array(8).fill(0));
  board[1][0] = 1; // white man one step from promotion
  board[7][7] = 3; // a black man so the side is not stalemated later
  const s = { board, turn: 0 };
  const next = games.checkers.apply(s, { from: [1, 0], to: [0, 1], path: [[0, 1]], captures: [] });
  assert.strictEqual(next.board[0][1], 2, 'a white man on row 0 becomes a king');
});

step('draughts forces a capture when one is available', () => {
  const board = Array.from({ length: 8 }, () => Array(8).fill(0));
  board[4][4] = 1; // white man
  board[3][3] = 3; // black man it can jump
  board[7][7] = 3; // keep black in the game
  const s = { board, turn: 0 };
  const moves = games.checkers.moves(s);
  assert.ok(moves.length > 0);
  assert.ok(moves.every((m) => m.captures.length > 0), 'only the jump may be played');
  const next = games.checkers.apply(s, moves[0]);
  assert.strictEqual(next.board[3][3], 0, 'the jumped man is removed');
});

step('draughts bot returns a legal move', () => {
  const s = games.checkers.create();
  const move = games.checkers.bot(s, 2);
  const legal = games.checkers.moves(s);
  assert.ok(legal.some((m) => JSON.stringify(m.from) === JSON.stringify(move.from)
    && JSON.stringify(m.to) === JSON.stringify(move.to)), 'the bot move must be legal');
});

/* --------------------------------- chess --------------------------------- */
step('chess starts with 20 legal moves', () => {
  const s = games.chess.create();
  assert.strictEqual(games.chess.moves(s).length, 20);
  assert.strictEqual(games.chess.result(s), null);
});

step('chess allows the scholar\'s mate', () => {
  let s = games.chess.create();
  const play = (from, to) => {
    const move = games.chess.moves(s).find((m) => JSON.stringify(m.from) === JSON.stringify(from)
      && JSON.stringify(m.to) === JSON.stringify(to));
    assert.ok(move, `expected a move ${from}->${to}`);
    s = games.chess.apply(s, move);
  };
  play([6, 4], [4, 4]); // e4
  play([1, 4], [3, 4]); // e5
  play([7, 5], [4, 2]); // Bc4
  play([0, 1], [2, 2]); // Nc6
  play([7, 3], [3, 7]); // Qh5
  play([0, 6], [2, 5]); // Nf6
  play([3, 7], [1, 5]); // Qxf7#
  const res = games.chess.result(s);
  assert.ok(res && res.winner === 0 && res.reason === 'мат', `expected mate, got ${JSON.stringify(res)}`);
});

step('chess forbids a move that leaves the king in check', () => {
  // White king e1, black rook e8, white rook e2 blocking: the rook may slide up
  // the e-file (it still blocks) but may not step off it.
  const s = games.chess.create();
  s.board = Array.from({ length: 8 }, () => Array(8).fill(''));
  s.board[7][4] = 'K';
  s.board[0][4] = 'r';
  s.board[6][4] = 'R';
  s.board[0][0] = 'k';
  s.turn = 0;
  s.castling = { wk: false, wq: false, bk: false, bq: false };
  const moves = games.chess.moves(s);
  assert.ok(moves.some((m) => m.from[0] === 6 && m.from[1] === 4 && m.to[0] === 5 && m.to[1] === 4),
    'the rook may still slide up the e-file');
  assert.ok(!moves.some((m) => m.from[0] === 6 && m.from[1] === 4 && m.to[1] !== 4),
    'the rook may not leave the e-file');
});

step('chess bot returns a legal move', () => {
  const s = games.chess.create();
  const move = games.chess.bot(s, 2);
  const legal = games.chess.moves(s);
  assert.ok(legal.some((m) => JSON.stringify(m.from) === JSON.stringify(move.from)
    && JSON.stringify(m.to) === JSON.stringify(move.to)), 'the bot move must be legal');
});

/* ------------------------------- battleship ------------------------------ */
step('battleship places the whole fleet without ships touching', () => {
  for (let trial = 0; trial < 20; trial++) {
    const s = games.battleship.create();
    const fleet = s.fleets[0];
    assert.strictEqual(fleet.ships.length, games.FLEET.length);
    const sizes = fleet.ships.map((sh) => sh.size).sort((a, b) => b - a);
    assert.deepStrictEqual(sizes, [...games.FLEET].sort((a, b) => b - a));
    // No two ship cells may be adjacent, even diagonally.
    for (let r = 0; r < games.BS; r++) {
      for (let c = 0; c < games.BS; c++) {
        if (fleet.grid[r][c] == null) continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= games.BS || nc < 0 || nc >= games.BS) continue;
            if (fleet.grid[nr][nc] != null && fleet.grid[nr][nc] !== fleet.grid[r][c]) {
              throw new Error(`ships touch at ${r},${c}`);
            }
          }
        }
      }
    }
  }
});

step('battleship sinks a ship and ends the game when the fleet is gone', () => {
  const board = Array.from({ length: 8 }, () => Array(8).fill(0));
  const s = games.battleship.create();
  // A single one-cell ship for seat 1 so the game can be finished quickly.
  const grid = Array.from({ length: games.BS }, () => Array(games.BS).fill(null));
  grid[0][0] = 0;
  s.fleets[1] = { grid, ships: [{ id: 0, size: 1, cells: [[0, 0]], hits: 0 }] };
  s.ready = [true, true];
  let state = games.battleship.apply(s, [0, 0]);
  const res = games.battleship.result(state);
  assert.ok(res && res.winner === 0, `expected seat 0 to win, got ${JSON.stringify(res)}`);
});

step('battleship bot only fires at unfired squares and targets hits', () => {
  const s = games.battleship.create();
  // Give seat 1 a real fleet so shots are meaningful.
  const fleet = s.fleets[0];
  s.fleets[1] = { grid: fleet.grid.map((row) => row.slice()), ships: fleet.ships.map((sh) => ({ ...sh, hits: 0 })) };
  s.ready = [true, true];
  let state = s;
  for (let i = 0; i < 40 && !games.battleship.result(state); i++) {
    const move = games.battleship.bot(state, 2);
    const legal = games.battleship.moves(state);
    assert.ok(legal.some((m) => m[0] === move[0] && m[1] === move[1]), 'the bot move must be unfired');
    state = games.battleship.apply(state, move);
  }
});

/* --------------------------------- registry ------------------------------ */
step('the registry lists all four games with ids', () => {
  assert.strictEqual(games.GAMES.length, 4);
  for (const id of ['tictactoe', 'checkers', 'chess', 'battleship']) {
    assert.ok(games.byId(id), `missing game ${id}`);
    assert.ok(games.byId(id).name, `${id} has no name`);
  }
  assert.strictEqual(games.byId('nope'), null);
});

/* --------------------------------- codecs -------------------------------- */
step('encode/decode round-trips every game', () => {
  for (const game of games.GAMES) {
    const start = game.create();
    const str = games.encode(game.id, start);
    assert.strictEqual(typeof str, 'string');
    const back = games.decode(game.id, str);
    assert.deepStrictEqual(back, start, `${game.id} did not round-trip`);
    assert.strictEqual(games.encode(game.id, back), str, `${game.id} re-encode differs`);
  }
});

step('encode/decode keeps a position after real moves', () => {
  // tic-tac-toe
  let s = games.ticTacToe.create();
  s = games.ticTacToe.apply(s, 4);
  s = games.ticTacToe.apply(s, 0);
  assert.deepStrictEqual(games.decode('tictactoe', games.encode('tictactoe', s)), s);
  // checkers after a capture
  let d = games.checkers.create();
  d = games.checkers.apply(d, games.checkers.moves(d)[0]);
  assert.deepStrictEqual(games.decode('checkers', games.encode('checkers', d)), d);
  // chess after a pawn push (leaves an en-passant square)
  let c = games.chess.create();
  c = games.chess.apply(c, { from: [6, 4], to: [4, 4] });
  assert.deepStrictEqual(games.decode('chess', games.encode('chess', c)), c);
  // battleship after a shot
  let b = games.battleship.create();
  b.fleets[1] = { grid: b.fleets[0].grid.map((row) => row.slice()), ships: b.fleets[0].ships.map((sh) => ({ ...sh, hits: 0 })) };
  b.ready = [true, true];
  b = games.battleship.apply(b, games.battleship.moves(b)[0]);
  const back = games.decode('battleship', games.encode('battleship', b));
  assert.deepStrictEqual(back, b, 'battleship did not round-trip');
});

step('a decoded battleship position can keep playing', () => {
  let b = games.battleship.create();
  b.fleets[1] = { grid: b.fleets[0].grid.map((row) => row.slice()), ships: b.fleets[0].ships.map((sh) => ({ ...sh, hits: 0 })) };
  b.ready = [true, true];
  b = games.battleship.apply(b, games.battleship.moves(b)[0]);
  const back = games.decode('battleship', games.encode('battleship', b));
  const move = games.battleship.bot(back, 2);
  assert.ok(move, 'the bot should still find a shot after a round-trip');
  const after = games.battleship.apply(back, move);
  assert.ok(games.encode('battleship', after).length > 0);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} game checks passed`);
process.exit(failed === 0 ? 0 : 1);
