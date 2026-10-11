'use strict';
/*
 * UNO — многопользовательская игра для браузера.
 * Сервер на чистом Node.js (без внешних зависимостей).
 * Запуск: node server.js   (порт по умолчанию 3000, можно задать PORT=8080)
 *
 * Сохранение игр:
 *  - по умолчанию в файл data/rooms.json (путь можно задать DATA_FILE);
 *  - если заданы UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN — в базу Upstash Redis
 *    (нужно для бесплатного Render, где файлы стираются при каждом перезапуске).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const HAND_SIZE = 7;
const TARGET_SCORE = 500;          // до скольки очков идёт партия (по умолчанию)
const TARGET_OPTIONS = [100, 200, 300, 500];
const ROUND_MINUTES = 10;          // длительность раунда по умолчанию, 0 — без ограничения
const ROUND_MINUTE_OPTIONS = [0, 3, 5, 10, 15, 20];
const PILE_VISIBLE = 10;           // сколько верхних карт сброса видно в стопке
const AFK_SECONDS = 30;            // через сколько секунд за отключившегося игрока ход делается автоматически
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // пустая комната удаляется через 3 часа без активности
const BOT_NAMES = ['Вася', 'Маша', 'Гоша', 'Оля', 'Петя', 'Зина', 'Тоша', 'Лиза'];
const BOT_DELAY_MS = [900, 1700];       // «раздумья» компьютера перед ходом
const BOT_UNO_CHANCE = 0.85;            // как часто компьютер не забывает крикнуть UNO

const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_NAMES = { red: 'красный', yellow: 'жёлтый', green: 'зелёный', blue: 'синий' };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_KEY = process.env.UPSTASH_KEY || 'uno:rooms';

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

/* ---------- утилиты ---------- */

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck() {
  const deck = [];
  let id = 0;
  const add = (color, value) => deck.push({ id: 'c' + (id++), color, value });
  for (const color of COLORS) {
    add(color, '0');
    for (let n = 1; n <= 9; n++) { add(color, String(n)); add(color, String(n)); }
    for (const v of ['skip', 'reverse', 'draw2']) { add(color, v); add(color, v); }
  }
  for (let i = 0; i < 4; i++) { add('wild', 'wild'); add('wild', 'wild4'); }
  return shuffle(deck); // 108 карт
}

function cardPoints(card) {
  if (/^\d$/.test(card.value)) return Number(card.value);
  if (card.value === 'wild' || card.value === 'wild4') return 50;
  return 20;
}

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  if (!s) fail('Введите имя');
  return s;
}

/* ---------- комната и игроки ---------- */

function createRoom() {
  const room = {
    code: newCode(),
    players: [],
    hostId: null,
    phase: 'lobby',          // lobby | playing | roundOver
    deck: [],
    discard: [],
    currentColor: null,
    turn: 0,
    direction: 1,
    drawnCardId: null,       // карта, взятая в этот ход (её можно сыграть или спасовать)
    turnStartedAt: 0,
    roundNo: 0,
    lastRound: null,
    gameOver: false,
    log: [],
    logSeq: 0,
    clients: new Set(),
    lastActivity: Date.now(),
    settings: { roundMinutes: ROUND_MINUTES, target: TARGET_SCORE },
    roundStartedAt: null,
    roundEndsAt: null,
    history: [],
  };
  rooms.set(room.code, room);
  return room;
}

function applySettings(room, body) {
  const st = room.settings;
  if (body.roundMinutes !== undefined) {
    const m = parseInt(body.roundMinutes, 10);
    if (!ROUND_MINUTE_OPTIONS.includes(m)) fail('Недопустимое время раунда');
    st.roundMinutes = m;
  }
  if (body.target !== undefined) {
    const t = parseInt(body.target, 10);
    if (!TARGET_OPTIONS.includes(t)) fail('Недопустимая цель партии');
    st.target = t;
  }
}

function addPlayer(room, name) {
  const player = {
    id: crypto.randomBytes(4).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name,
    hand: [],
    score: 0,
    saidUno: false,
    conns: 0,
    disconnectedAt: Date.now(),
    isBot: false,
  };
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  return player;
}

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) fail(`Максимум ${MAX_PLAYERS} игроков`);
  if (room.phase === 'playing') fail('Добавить компьютер можно между раундами');
  const taken = new Set(room.players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !taken.has(n)) || `Бот ${room.players.length + 1}`;
  const bot = addPlayer(room, name);
  bot.isBot = true;
  bot.token = null;
  log(room, `${name} 🤖 присоединяется`);
  return bot;
}

const humans = (room) => room.players.filter((p) => !p.isBot);

function log(room, text, extra = {}) {
  room.log.push({ id: ++room.logSeq, text, ...extra });
  if (room.log.length > 40) room.log.shift();
}

const topCard = (room) => room.discard[room.discard.length - 1];
const currentPlayer = (room) => room.players[room.turn];
const nextIndex = (room, from, steps = 1) => {
  const n = room.players.length;
  return (((from + room.direction * steps) % n) + n) % n;
};

function setTurn(room, idx) {
  room.turn = idx;
  room.drawnCardId = null;
  room.turnStartedAt = Date.now();
}
const advance = (room, steps = 1) => setTurn(room, nextIndex(room, room.turn, steps));

function recycleDeck(room) {
  if (room.discard.length <= 1) return;
  const top = room.discard.pop();
  room.deck = shuffle(room.discard);
  room.discard = [top];
  log(room, 'Колода закончилась — сброс перемешан', { fx: 'shuffle' });
}

function drawCards(room, player, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (!room.deck.length) recycleDeck(room);
    if (!room.deck.length) break;
    const card = room.deck.pop();
    player.hand.push(card);
    drawn.push(card);
  }
  if (player.hand.length > 1) player.saidUno = false;
  return drawn;
}

function isPlayable(room, player, card) {
  if (room.drawnCardId && card.id !== room.drawnCardId) return false;
  if (card.value === 'wild') return true;
  // «Закажи цвет +4» — только если на руке нет карт текущего цвета (официальное правило)
  if (card.value === 'wild4') return !player.hand.some((c) => c.color === room.currentColor);
  return card.color === room.currentColor || card.value === topCard(room).value;
}

/* ---------- ход игры ---------- */

function startRound(room) {
  if (room.players.length < MIN_PLAYERS) fail(`Нужно минимум ${MIN_PLAYERS} игрока`);
  if (room.gameOver) {
    room.players.forEach((p) => { p.score = 0; });
    room.gameOver = false;
    room.roundNo = 0;
    room.history = [];
  }
  room.deck = buildDeck();
  room.discard = [];
  room.direction = 1;
  room.lastRound = null;
  for (const p of room.players) { p.hand = []; p.saidUno = false; }
  for (let i = 0; i < HAND_SIZE; i++) for (const p of room.players) p.hand.push(room.deck.pop());

  // Первая карта сброса — только цифровая; остальные возвращаются в колоду
  let first = room.deck.pop();
  while (!/^\d$/.test(first.value)) {
    room.deck.splice(crypto.randomInt(room.deck.length + 1), 0, first);
    first = room.deck.pop();
  }
  room.discard.push(first);
  room.currentColor = first.color;
  room.phase = 'playing';
  room.roundStartedAt = Date.now();
  room.roundEndsAt = room.settings.roundMinutes ? room.roundStartedAt + room.settings.roundMinutes * 60000 : null;
  setTurn(room, room.roundNo % room.players.length);
  room.roundNo++;
  log(room, `Раунд ${room.roundNo} начался. Первым ходит ${currentPlayer(room).name}`, { fx: 'deal' });
}

function playCard(room, player, cardId, chosenColor) {
  const idx = player.hand.findIndex((c) => c.id === cardId);
  if (idx < 0) fail('Такой карты нет на руке');
  const card = player.hand[idx];
  if (!isPlayable(room, player, card)) {
    fail(card.value === 'wild4'
      ? '«+4» можно сыграть, только если нет карт текущего цвета'
      : 'Эту карту сейчас положить нельзя');
  }
  const isWild = card.color === 'wild';
  if (isWild && !COLORS.includes(chosenColor)) fail('Выберите цвет');

  player.hand.splice(idx, 1);
  room.discard.push(card);
  room.currentColor = isWild ? chosenColor : card.color;
  room.drawnCardId = null;
  log(room, `${player.name} кладёт`, { card, color: isWild ? chosenColor : null, fx: 'play', by: player.id, last: player.hand.length });

  const n = room.players.length;
  const victimIdx = nextIndex(room, room.turn, 1);
  const victim = room.players[victimIdx];

  if (card.value === 'draw2' || card.value === 'wild4') {
    const k = card.value === 'draw2' ? 2 : 4;
    drawCards(room, victim, k);
    log(room, `${victim.name} берёт ${k} карты и пропускает ход`, { fx: 'draw', target: victim.id, n: k, penalty: true });
  }

  if (player.hand.length === 0) return endRound(room, player);

  switch (card.value) {
    case 'skip':
      log(room, `${victim.name} пропускает ход`, { fx: 'skip', target: victim.id });
      advance(room, 2);
      break;
    case 'reverse':
      room.direction *= -1;
      if (n === 2) { advance(room, 2); log(room, `${victim.name} пропускает ход`, { fx: 'reverse', target: victim.id }); }
      else { advance(room, 1); log(room, 'Направление игры изменилось', { fx: 'reverse' }); }
      break;
    case 'draw2':
    case 'wild4':
      advance(room, 2);
      break;
    default:
      advance(room, 1);
  }
}

const handPoints = (p) => p.hand.reduce((s, c) => s + cardPoints(c), 0);

// reason: 'out' — игрок избавился от карт, 'time' — вышло время раунда
function endRound(room, winner, reason = 'out') {
  let points = 0;
  const hands = room.players.map((p) => {
    const pts = handPoints(p);
    if (p !== winner) points += pts;
    return { id: p.id, name: p.name, cards: p.hand.slice(), points: pts };
  });
  winner.score += points;
  room.phase = 'roundOver';
  room.drawnCardId = null;
  room.gameOver = winner.score >= room.settings.target;
  const durationSec = Math.round((Date.now() - (room.roundStartedAt || Date.now())) / 1000);
  room.lastRound = { winnerId: winner.id, winnerName: winner.name, points, hands, reason, durationSec };
  room.history.push({ round: room.roundNo, winnerName: winner.name, points, reason, durationSec });
  if (room.history.length > 50) room.history.shift();
  room.roundEndsAt = null;
  log(room, `${winner.name} выигрывает раунд и получает ${points} очк.`, { fx: 'win', by: winner.id, game: room.gameOver });
  if (room.gameOver) log(room, `${winner.name} набирает ${winner.score} очков и побеждает в игре!`);
}

// Время раунда вышло: побеждает тот, у кого на руке меньше всего очков (при равенстве — меньше карт)
function endRoundByTime(room) {
  const order = [];
  for (let k = 0; k < room.players.length; k++) order.push(room.players[nextIndex(room, room.turn, k)]);
  const winner = order.reduce((best, p) => {
    const a = handPoints(p), b = handPoints(best);
    return a < b || (a === b && p.hand.length < best.hand.length) ? p : best;
  });
  log(room, `Время раунда вышло! Меньше всего очков на руке у ${winner.name}`, { fx: 'timeup' });
  endRound(room, winner, 'time');
}

function removePlayer(room, player) {
  const idx = room.players.indexOf(player);
  if (idx < 0) return;
  let currentId = null;
  if (room.phase === 'playing') {
    currentId = currentPlayer(room).id;
    if (currentId === player.id) currentId = room.players[nextIndex(room, room.turn, 1)].id;
    room.deck.unshift(...player.hand); // карты ушедшего — под низ колоды
  }
  player.hand = [];
  room.players.splice(idx, 1);
  for (const c of [...room.clients]) {
    if (c.player === player) {
      room.clients.delete(c);
      try { c.res.write('event: kicked\ndata: {}\n\n'); c.res.end(); } catch (e) { /* ignore */ }
    }
  }
  if (room.hostId === player.id) { const h = humans(room)[0]; room.hostId = h ? h.id : null; }
  log(room, `${player.name} покидает игру`);

  if (room.phase === 'playing') {
    if (room.players.length < MIN_PLAYERS) {
      room.phase = 'lobby';
      log(room, 'Игроков не хватает — раунд остановлен');
    } else {
      const ni = room.players.findIndex((p) => p.id === currentId);
      const wasCurrent = currentId !== null && idx === room.turn;
      if (wasCurrent) setTurn(room, ni); // ход переходит следующему
      else room.turn = ni;               // ход у того же игрока, сдвинулся только индекс
    }
  }
  if (!humans(room).length) { clearBotTimers(room); rooms.delete(room.code); markDirty(); }
}

/* ---------- представление состояния для конкретного игрока ---------- */

function viewFor(room, player) {
  const playing = room.phase === 'playing';
  const cur = playing ? currentPlayer(room) : null;
  const myTurn = !!cur && cur.id === player.id;
  return {
    room: room.code,
    phase: room.phase,
    me: player.id,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      count: p.hand.length,
      online: p.isBot || p.conns > 0,
      isBot: p.isBot,
      score: p.score,
      saidUno: p.saidUno,
      catchable: playing && p.hand.length === 1 && !p.saidUno,
    })),
    hand: player.hand,
    playable: myTurn ? player.hand.filter((c) => isPlayable(room, player, c)).map((c) => c.id) : [],
    turnId: cur ? cur.id : null,
    direction: room.direction,
    top: topCard(room) || null,
    currentColor: room.currentColor,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    drawnCardId: myTurn ? room.drawnCardId : null,
    canUno: playing && !player.saidUno && (player.hand.length === 1 || (myTurn && player.hand.length === 2)),
    roundNo: room.roundNo,
    lastRound: room.lastRound,
    gameOver: room.gameOver,
    target: room.settings.target,
    settings: room.settings,
    options: { roundMinutes: ROUND_MINUTE_OPTIONS, target: TARGET_OPTIONS },
    roundEndsAt: room.roundEndsAt,
    serverNow: Date.now(),
    history: room.history.slice(-20),
    pile: room.discard.slice(-PILE_VISIBLE),
    afkSeconds: AFK_SECONDS,
    log: room.log.slice(-14),
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
  };
}

function broadcast(room) {
  for (const c of room.clients) {
    try { c.res.write(`data: ${JSON.stringify(viewFor(room, c.player))}\n\n`); } catch (e) { /* ignore */ }
  }
  scheduleBots(room);
  markDirty();
}

/* ---------- общие действия (для людей и компьютера) ---------- */

function doDraw(room, player) {
  if (room.drawnCardId) fail('Вы уже взяли карту — сыграйте её или пасуйте');
  const [card] = drawCards(room, player, 1);
  if (!card) { log(room, `${player.name} пропускает ход (колода пуста)`); advance(room, 1); return; }
  if (isPlayable(room, player, card)) {
    room.drawnCardId = card.id;
    log(room, `${player.name} берёт карту`, { fx: 'draw', target: player.id, n: 1 });
  } else {
    log(room, `${player.name} берёт карту и пропускает ход`, { fx: 'draw', target: player.id, n: 1 });
    advance(room, 1);
  }
}

function doPass(room, player) {
  if (!room.drawnCardId) fail('Сначала возьмите карту из колоды');
  log(room, `${player.name} пасует`);
  advance(room, 1);
}

function doUno(room, player) {
  if (player.saidUno) return;
  player.saidUno = true;
  log(room, `${player.name}: «UNO!»`, { uno: true, fx: 'uno', by: player.id });
}

function doCatch(room, player, target) {
  if (!target || target === player) fail('Некого ловить');
  if (target.hand.length !== 1 || target.saidUno) fail('Поздно — ловить уже нечего');
  drawCards(room, target, 2);
  log(room, `${player.name} ловит ${target.name} без «UNO» — штраф +2 карты`, { fx: 'catch', by: player.id, target: target.id, n: 2 });
}

/* ---------- компьютерные игроки ---------- */

const rand = (a, b) => a + Math.random() * (b - a);

function clearBotTimers(room) {
  clearTimeout(room.botTimer); room.botTimer = null;
  clearTimeout(room.catchTimer); room.catchTimer = null;
}

function scheduleBots(room) {
  if (room.phase !== 'playing' || !rooms.has(room.code)) { clearBotTimers(room); return; }
  // компьютер ходит, только пока за столом есть кто-то из людей
  if (!humans(room).some((p) => p.conns > 0)) return;

  const cur = currentPlayer(room);
  if (cur && cur.isBot && !room.botTimer) {
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (room.phase !== 'playing' || currentPlayer(room) !== cur) { broadcast(room); return; }
      try { botMove(room, cur); } catch (e) { console.error('bot', e); if (currentPlayer(room) === cur) advance(room, 1); }
      broadcast(room);
    }, rand(BOT_DELAY_MS[0], BOT_DELAY_MS[1]) + (room.drawnCardId ? -300 : 0));
  }

  // компьютер ловит тех, кто забыл крикнуть UNO
  const bots = room.players.filter((p) => p.isBot);
  const victim = room.players.find((p) => p.hand.length === 1 && !p.saidUno);
  if (bots.length && victim && !room.catchTimer) {
    const candidates = bots.filter((b) => b !== victim);
    if (!candidates.length) return;
    const catcher = candidates[crypto.randomInt(candidates.length)];
    room.catchTimer = setTimeout(() => {
      room.catchTimer = null;
      if (room.phase === 'playing' && victim.hand.length === 1 && !victim.saidUno && room.players.includes(victim)) {
        doCatch(room, catcher, victim);
        broadcast(room);
      }
    }, rand(2200, 4000));
  }
}

function botColor(bot, except) {
  const cnt = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of bot.hand) if (c !== except && cnt[c.color] !== undefined) cnt[c.color] += 1 + (/^\d$/.test(c.value) ? 0 : 0.5);
  const best = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  return best[0][1] > 0 ? best[0][0] : COLORS[crypto.randomInt(4)];
}

function botPick(room, bot, playable) {
  const next = room.players[nextIndex(room, room.turn, 1)];
  const danger = next.hand.length <= 2;          // следующий близок к победе — бьём его
  const endgame = bot.hand.length <= 3;
  const cnt = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of bot.hand) if (cnt[c.color] !== undefined) cnt[c.color]++;
  let best = null, bestScore = -Infinity;
  for (const c of playable) {
    let sc;
    if (/^\d$/.test(c.value)) sc = 10 + Number(c.value) * 0.4;
    else if (c.value === 'wild') sc = endgame ? 22 : 2;
    else if (c.value === 'wild4') sc = danger ? 40 : (endgame ? 24 : 1);
    else sc = danger ? 32 : 12;                    // пропуск / разворот / +2
    if (cnt[c.color] !== undefined) sc += cnt[c.color] * 1.5;
    sc += Math.random() * 3;
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  return best;
}

function botMove(room, bot) {
  if (room.drawnCardId) {
    const card = bot.hand.find((c) => c.id === room.drawnCardId);
    if (card && (Math.random() < 0.85 || bot.hand.length <= 3)) {
      if (bot.hand.length === 2 && Math.random() < BOT_UNO_CHANCE) doUno(room, bot);
      playCard(room, bot, card.id, card.color === 'wild' ? botColor(bot, card) : undefined);
    } else doPass(room, bot);
    return;
  }
  const playable = bot.hand.filter((c) => isPlayable(room, bot, c));
  if (!playable.length) { doDraw(room, bot); return; }
  const card = botPick(room, bot, playable);
  if (bot.hand.length === 2 && Math.random() < BOT_UNO_CHANCE) doUno(room, bot);
  playCard(room, bot, card.id, card.color === 'wild' ? botColor(bot, card) : undefined);
}

/* ---------- API ---------- */

function findPlayer(body) {
  const room = rooms.get(String(body.room || '').toUpperCase().trim());
  if (!room) fail('Комната не найдена');
  const player = body.token ? room.players.find((p) => p.token === body.token) : null;
  if (!player) fail('Вы не участник этой комнаты');
  room.lastActivity = Date.now();
  return { room, player };
}

function handleApi(name, body) {
  if (name === 'create') {
    const pname = cleanName(body.name);
    const room = createRoom();
    const player = addPlayer(room, pname);
    applySettings(room, body);
    log(room, `${pname} создаёт комнату`);
    const nBots = Math.max(0, Math.min(MAX_PLAYERS - 1, parseInt(body.bots, 10) || 0));
    if (nBots) {
      for (let i = 0; i < nBots; i++) addBot(room);
      startRound(room);
    }
    markDirty();
    return { room: room.code, token: player.token, playerId: player.id };
  }

  if (name === 'join') {
    const code = String(body.room || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) fail('Комната не найдена. Проверьте код');
    room.lastActivity = Date.now();
    const existing = body.token && room.players.find((p) => p.token === body.token);
    if (existing) return { room: room.code, token: existing.token, playerId: existing.id };
    const pname = cleanName(body.name);
    if (room.phase === 'playing') fail('Игра уже идёт — подключиться можно между раундами');
    if (room.players.length >= MAX_PLAYERS) fail(`Комната заполнена (максимум ${MAX_PLAYERS})`);
    if (room.players.some((p) => p.name.toLowerCase() === pname.toLowerCase())) fail('Это имя уже занято в комнате');
    const player = addPlayer(room, pname);
    log(room, `${pname} присоединяется`);
    broadcast(room);
    return { room: room.code, token: player.token, playerId: player.id };
  }

  if (name === 'action') {
    const { room, player } = findPlayer(body);
    const isHost = room.hostId === player.id;
    const myTurn = room.phase === 'playing' && currentPlayer(room).id === player.id;
    const needTurn = () => {
      if (room.phase !== 'playing') fail('Раунд не идёт');
      if (!myTurn) fail('Сейчас не ваш ход');
    };

    switch (body.type) {
      case 'start':
        if (!isHost) fail('Начать игру может только создатель комнаты');
        if (room.phase === 'playing') fail('Игра уже идёт');
        startRound(room);
        break;

      case 'play':
        needTurn();
        playCard(room, player, String(body.cardId), body.color);
        break;

      case 'draw':
        needTurn();
        doDraw(room, player);
        break;

      case 'pass':
        needTurn();
        doPass(room, player);
        break;

      case 'uno':
        if (room.phase !== 'playing') fail('Раунд не идёт');
        if (!(player.hand.length === 1 || (myTurn && player.hand.length === 2))) fail('UNO можно крикнуть, когда остаётся одна карта');
        doUno(room, player);
        break;

      case 'catch': {
        if (room.phase !== 'playing') fail('Раунд не идёт');
        doCatch(room, player, room.players.find((p) => p.id === body.target));
        break;
      }

      case 'nextRound':
        if (!isHost) fail('Следующий раунд запускает создатель комнаты');
        if (room.phase !== 'roundOver') fail('Раунд ещё не закончен');
        startRound(room);
        break;

      case 'settings':
        if (!isHost) fail('Настройки меняет создатель комнаты');
        if (room.phase === 'playing') fail('Настройки можно менять между раундами');
        applySettings(room, body);
        log(room, `Настройки: раунд — ${room.settings.roundMinutes ? room.settings.roundMinutes + ' мин' : 'без ограничения'}, партия до ${room.settings.target} очков`);
        if (room.phase === 'roundOver') {
          const leader = Math.max(...room.players.map((p) => p.score));
          room.gameOver = leader >= room.settings.target;
        }
        break;

      case 'addBot':
        if (!isHost) fail('Добавлять компьютер может только создатель комнаты');
        addBot(room);
        break;

      case 'kick': {
        if (!isHost) fail('Удалять игроков может только создатель комнаты');
        const target = room.players.find((p) => p.id === body.target);
        if (!target || target === player) fail('Игрок не найден');
        removePlayer(room, target);
        break;
      }

      case 'leave':
        removePlayer(room, player);
        if (rooms.has(room.code)) broadcast(room);
        return { ok: true };

      default:
        fail('Неизвестное действие');
    }
    broadcast(room);
    return { ok: true };
  }

  fail('Неизвестный запрос');
}

/* ---------- SSE: поток обновлений ---------- */

function handleEvents(req, res, url) {
  const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
  const token = url.searchParams.get('token');
  const player = room && token && room.players.find((p) => p.token === token);
  if (!player) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // отключает буферизацию в nginx
  });
  res.write('retry: 2000\n\n');
  const client = { res, player };
  room.clients.add(client);
  player.conns++;
  player.disconnectedAt = null;
  room.lastActivity = Date.now();
  broadcast(room);

  req.on('close', () => {
    if (!room.clients.delete(client)) return;
    player.conns = Math.max(0, player.conns - 1);
    if (player.conns === 0) player.disconnectedAt = Date.now();
    broadcast(room);
  });
}

/* ---------- статика ---------- */

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/fx.js': ['fx.js', 'application/javascript; charset=utf-8'],
};

function serveStatic(pathname, res) {
  const entry = STATIC[pathname];
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
  fs.readFile(path.join(PUBLIC_DIR, entry[0]), (err, data) => {
    if (err) { res.writeHead(500); res.end('Ошибка чтения файла'); return; }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) { reject(new GameError('Слишком большой запрос')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new GameError('Неверный формат запроса')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readJson(req);
      return sendJson(res, 200, handleApi(url.pathname.slice(5), body));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);
    sendJson(res, 405, { error: 'Метод не поддерживается' });
  } catch (e) {
    if (e instanceof GameError) sendJson(res, 400, { error: e.message });
    else { console.error(e); sendJson(res, 500, { error: 'Ошибка сервера' }); }
  }
});

/* ---------- фоновые задачи ---------- */

// Автоход за отключившегося игрока: берёт карту и пропускает ход
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'playing') continue;
    if (room.roundEndsAt && now >= room.roundEndsAt) {
      clearBotTimers(room);
      endRoundByTime(room);
      broadcast(room);
      continue;
    }
    const cur = currentPlayer(room);
    if (!cur || cur.isBot || cur.conns > 0) continue;
    if (!humans(room).some((p) => p.conns > 0)) continue; // все офлайн — ждём
    const since = Math.max(cur.disconnectedAt || 0, room.turnStartedAt);
    if (now - since < AFK_SECONDS * 1000) continue;
    if (!room.drawnCardId) drawCards(room, cur, 1);
    log(room, `${cur.name} не в сети — автоматически берёт карту и пропускает ход`, { fx: 'draw', target: cur.id, n: room.drawnCardId ? 0 : 1 });
    advance(room, 1);
    broadcast(room);
  }
}, 1000);

// Пинг, чтобы прокси не закрывали соединение, и удаление старых комнат
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const c of room.clients) { try { c.res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
    if (room.clients.size === 0 && now - room.lastActivity > ROOM_TTL_MS) { rooms.delete(room.code); markDirty(); }
  }
}, 20000);

/* ---------- сохранение и восстановление ---------- */

const SAVE_DELAY_MS = 4000;
let dirty = false;
let saveTimer = null;
let saving = Promise.resolve();

function serialize() {
  const out = [];
  for (const r of rooms.values()) {
    const { clients, botTimer, catchTimer, ...rest } = r;
    rest.players = r.players.map(({ conns, disconnectedAt, ...p }) => p);
    out.push(rest);
  }
  return JSON.stringify({ v: 1, savedAt: Date.now(), rooms: out });
}

function restore(json) {
  const data = JSON.parse(json);
  const now = Date.now();
  for (const r of data.rooms || []) {
    r.clients = new Set();
    r.botTimer = null;
    r.catchTimer = null;
    r.settings = Object.assign({ roundMinutes: ROUND_MINUTES, target: TARGET_SCORE }, r.settings);
    r.history = r.history || [];
    r.players.forEach((p) => { p.conns = 0; p.disconnectedAt = now; });
    if (r.phase === 'playing') r.turnStartedAt = now;
    if (now - (r.lastActivity || 0) > ROOM_TTL_MS) continue;
    rooms.set(r.code, r);
  }
}

async function upstash(cmd) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Upstash HTTP ${res.status}`);
  return data.result;
}

async function writeState() {
  const json = serialize();
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    await upstash(['SET', UPSTASH_KEY, json]);
  } else {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, json);
    await fs.promises.rename(tmp, DATA_FILE);
  }
}

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return saving;
  dirty = false;
  saving = saving.then(writeState).catch((e) => { console.error('Не удалось сохранить игры:', e.message); dirty = true; });
  return saving;
}

async function loadState() {
  try {
    let json = null;
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      json = await upstash(['GET', UPSTASH_KEY]);
      console.log('Хранилище: Upstash Redis');
    } else {
      json = await fs.promises.readFile(DATA_FILE, 'utf8').catch(() => null);
      console.log('Хранилище: файл ' + DATA_FILE);
    }
    if (json) restore(json);
    console.log(`Восстановлено комнат: ${rooms.size}`);
  } catch (e) {
    console.error('Не удалось загрузить сохранённые игры:', e.message);
  }
}

// Render и pm2 перед остановкой присылают SIGTERM — успеваем сохранить
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    dirty = true;
    const timeout = new Promise((r) => setTimeout(r, 8000));
    await Promise.race([flush(), timeout]);
    process.exit(0);
  });
}

loadState().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`UNO-сервер запущен: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
});
