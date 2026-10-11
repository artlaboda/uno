'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'uno-session';
  const COLOR_NAMES = { red: 'красный', yellow: 'жёлтый', green: 'зелёный', blue: 'синий' };
  const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const VALUE_ORDER = { skip: 10, reverse: 11, draw2: 12, wild: 13, wild4: 14 };

  let session = null;   // { room, token, name }
  let view = null;      // последнее состояние от сервера
  let es = null;        // EventSource
  let pendingWildId = null;
  let prevHandIds = new Set();
  let prevTopId = null;
  let prevTurnMine = false;
  let lastLogId = 0;
  let lastFxId = null;   // последний обработанный эффект (null — ещё не инициализировано)
  let playRect = null;   // откуда полетела моя карта
  let prevPlayerCount = 0;

  /* ---------- хранилище ---------- */
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    clear() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } },
    name() { try { return localStorage.getItem('uno-name') || ''; } catch (e) { return ''; } },
    setName(n) { try { localStorage.setItem('uno-name', n); } catch (e) { /* ignore */ } },
  };

  /* ---------- сеть ---------- */
  async function api(path, body) {
    const res = await fetch('api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error(data.error || 'Ошибка соединения');
    return data;
  }

  function act(type, extra) {
    if (!session) return Promise.resolve();
    return api('action', Object.assign({ room: session.room, token: session.token, type }, extra || {}))
      .catch((e) => toast(e.message));
  }

  function connect() {
    if (es) es.close();
    const url = `api/events?room=${encodeURIComponent(session.room)}&token=${encodeURIComponent(session.token)}`;
    es = new EventSource(url);
    lastFxId = null;
    es.onopen = () => $('conn').classList.add('hidden');
    es.onmessage = (e) => {
      $('conn').classList.add('hidden');
      let nv;
      try { nv = JSON.parse(e.data); } catch (err) { return; }
      handleView(nv);
    };
    es.addEventListener('kicked', () => {
      es.close(); es = null;
      leaveLocal('Вы вышли из комнаты');
    });
    es.onerror = () => {
      if (!session) return;
      $('conn').classList.remove('hidden');
      if (es && es.readyState === EventSource.CLOSED) setTimeout(checkAlive, 1500);
    };
  }

  // Поток закрылся: проверяем, существует ли ещё комната и мы в ней
  async function checkAlive() {
    if (!session) return;
    try {
      await api('join', { room: session.room, token: session.token, name: session.name });
      connect();
    } catch (e) {
      if (/не найдена|не участник/i.test(e.message)) leaveLocal('Комната больше не существует');
      else setTimeout(checkAlive, 3000);
    }
  }

  function enterRoom(data, name) {
    session = { room: data.room, token: data.token, name };
    store.set(session);
    const u = new URL(location.href);
    u.searchParams.set('room', data.room);
    history.replaceState(null, '', u);
    connect();
  }

  function leaveLocal(message) {
    if (es) { es.close(); es = null; }
    session = null; view = null;
    store.clear();
    const u = new URL(location.href);
    u.searchParams.delete('room');
    history.replaceState(null, '', u);
    document.body.classList.remove('my-turn');
    document.title = 'UNO онлайн';
    $('conn').classList.add('hidden');
    show('home');
    hideOverlays();
    if (message) toast(message, true);
  }

  /* ---------- стартовый экран ---------- */
  function getName() {
    const name = $('nameInput').value.trim();
    if (!name) { toast('Введите имя'); $('nameInput').focus(); return null; }
    store.setName(name);
    return name;
  }

  $('createBtn').onclick = async () => {
    const name = getName(); if (!name) return;
    try { enterRoom(await api('create', { name }), name); } catch (e) { toast(e.message); }
  };

  $('joinBtn').onclick = async () => {
    const name = getName(); if (!name) return;
    const room = $('codeInput').value.trim().toUpperCase();
    if (room.length < 5) { toast('Введите код комнаты из 5 символов'); return; }
    try { enterRoom(await api('join', { room, name }), name); } catch (e) { toast(e.message); }
  };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('codeInput').value.trim() ? $('joinBtn') : $('createBtn')).click();
  });

  /* ---------- лобби ---------- */
  $('copyLinkBtn').onclick = () => {
    const link = shareLink();
    const done = () => toast('Ссылка скопирована', true);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(done, () => prompt('Скопируйте ссылку:', link));
    } else {
      prompt('Скопируйте ссылку:', link);
    }
  };
  $('startBtn').onclick = () => act('start');
  $('lobbyLeaveBtn').onclick = leave;
  $('gameLeaveBtn').onclick = () => { if (confirm('Выйти из игры? Ваши карты вернутся в колоду.')) leave(); };

  async function leave() {
    if (session) await act('leave');
    leaveLocal();
  }

  function shareLink() {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', view ? view.room : session.room);
    return u.toString();
  }

  /* ---------- игровые кнопки ---------- */
  $('deck').onclick = () => { if (canDraw()) act('draw'); };
  $('drawBtn').onclick = () => act('draw');
  $('passBtn').onclick = () => act('pass');
  $('unoBtn').onclick = () => act('uno');
  $('nextRoundBtn').onclick = () => act('nextRound');
  function syncMute() { $('muteBtn').textContent = UnoFX.isMuted() ? '🔇' : '🔊'; $('muteBtn').title = UnoFX.isMuted() ? 'Включить звук' : 'Выключить звук'; }
  $('muteBtn').onclick = () => { UnoFX.setMuted(!UnoFX.isMuted()); syncMute(); if (!UnoFX.isMuted()) UnoFX.sfx.flick(); };
  syncMute();
  UnoFX.setCardFactory((c, o) => makeCard(c, o));
  $('logToggle').onclick = () => $('logPanel').classList.toggle('open');
  $('logClose').onclick = () => $('logPanel').classList.remove('open');

  document.querySelectorAll('#colorPicker .swatch').forEach((b) => {
    b.onclick = () => {
      const id = pendingWildId; pendingWildId = null;
      $('colorPicker').classList.add('hidden');
      if (id) act('play', { cardId: id, color: b.dataset.color });
    };
  });
  $('colorCancel').onclick = () => { pendingWildId = null; $('colorPicker').classList.add('hidden'); };

  function onCardClick(card, el) {
    if (!view || view.turnId !== view.me) { toast('Сейчас не ваш ход'); UnoFX.sfx.error(); return; }
    if (!view.playable.includes(card.id)) {
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      UnoFX.sfx.error();
      return;
    }
    playRect = el.getBoundingClientRect();
    if (card.color === 'wild') {
      pendingWildId = card.id;
      $('colorPicker').classList.remove('hidden');
    } else {
      act('play', { cardId: card.id });
    }
  }

  const canDraw = () => view && view.phase === 'playing' && view.turnId === view.me && !view.drawnCardId;

  /* ---------- отрисовка карт ---------- */
  function cardLabel(v) {
    switch (v) {
      case 'skip': return { sym: '⊘', corner: '⊘', icon: true };
      case 'reverse': return { sym: '⇄', corner: '⇄', icon: true };
      case 'draw2': return { sym: '+2', corner: '+2' };
      case 'wild': return { sym: '', corner: 'W' };
      case 'wild4': return { sym: '+4', corner: '+4' };
      default: return { sym: v, corner: v, underline: v === '6' || v === '9' };
    }
  }

  function makeCard(card, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = `card ${card.color}` + (opts.mini ? ' mini' : '');
    if (card.color === 'wild' && opts.chosen) el.classList.add('chosen-' + opts.chosen);
    const lab = cardLabel(card.value);
    const oval = document.createElement('div'); oval.className = 'oval';
    const sym = document.createElement('div');
    sym.className = 'sym' + (lab.icon ? ' icon' : '') + (lab.underline ? ' u' : '');
    sym.textContent = lab.sym;
    const tl = document.createElement('span'); tl.className = 'corner tl'; tl.textContent = lab.corner;
    const br = document.createElement('span'); br.className = 'corner br'; br.textContent = lab.corner;
    el.append(oval, sym, tl, br);
    el.title = describeCard(card);
    return el;
  }

  function describeCard(c) {
    const names = { skip: 'Пропуск', reverse: 'Разворот', draw2: '+2', wild: 'Закажи цвет', wild4: 'Закажи цвет +4' };
    const n = names[c.value] || c.value;
    return c.color === 'wild' ? n : `${n} (${COLOR_NAMES[c.color]})`;
  }

  function sortHand(hand) {
    const vo = (v) => (v in VALUE_ORDER ? VALUE_ORDER[v] : Number(v));
    return hand.slice().sort((a, b) => COLOR_ORDER[a.color] - COLOR_ORDER[b.color] || vo(a.value) - vo(b.value));
  }

  /* ---------- новое состояние + эффекты ---------- */
  function handleView(nv) {
    const fresh = lastFxId === null;
    const entries = fresh ? [] : nv.log.filter((x) => x.id > lastFxId && x.fx);
    if (nv.log.length) lastFxId = Math.max(lastFxId || 0, nv.log[nv.log.length - 1].id);
    const wasMine = prevTurnMine;
    const prevCount = prevPlayerCount;
    view = nv;
    render();
    const myTurn = view.phase === 'playing' && view.turnId === view.me;
    prevTurnMine = myTurn;
    prevPlayerCount = view.players.length;

    if (fresh) return;
    if (view.phase === 'lobby') {
      if (view.players.length > prevCount) UnoFX.sfx.join();
      return;
    }
    const dur = UnoFX.process(entries, fxContext());
    playRect = null;
    if (myTurn && !wasMine) {
      setTimeout(() => {
        if (!(view && view.phase === 'playing' && view.turnId === view.me)) return;
        UnoFX.myTurn();
        const st = $('status');
        st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash');
        if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) { /* ignore */ } }
      }, dur + 80);
    }
  }

  function fxContext() {
    const boxOf = (id) => document.querySelector(`.opp[data-id="${id}"]`);
    const handRect = () => {
      const cards = $('hand').querySelectorAll('.card');
      return cards.length ? cards[cards.length - 1].getBoundingClientRect() : $('hand').getBoundingClientRect();
    };
    return {
      me: view.me,
      topId: view.top ? view.top.id : null,
      playRect,
      deckEl: $('deck'),
      discardEl: $('discard'),
      dirEl: $('dirIndicator'),
      handRect,
      boxOf: (id) => (id === view.me ? $('hand') : boxOf(id)),
      rectOf: (id) => {
        if (id === view.me) return handRect();
        const b = boxOf(id);
        return b ? b.getBoundingClientRect() : $('deck').getBoundingClientRect();
      },
      playerIds: () => view.players.map((p) => p.id),
    };
  }

  /* ---------- общий рендер ---------- */
  function show(id) {
    ['home', 'lobby', 'game'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
  }
  function hideOverlays() {
    $('colorPicker').classList.add('hidden');
    $('roundOver').classList.add('hidden');
  }

  function render() {
    if (!view) return;
    if (view.phase === 'lobby') {
      show('lobby');
      hideOverlays();
      renderLobby();
      document.body.classList.remove('my-turn');
      document.title = 'UNO онлайн — комната ' + view.room;
    } else {
      show('game');
      renderGame();
      renderRoundOver();
    }
  }

  function playerRow(p, extra) {
    const li = document.createElement('li');
    const av = document.createElement('div'); av.className = 'avatar'; av.textContent = p.name[0].toUpperCase();
    const name = document.createElement('div'); name.className = 'grow';
    name.textContent = p.name + (p.id === view.me ? ' (вы)' : '') + (p.id === view.hostId ? ' 👑' : '');
    const dot = document.createElement('span'); dot.className = 'dot' + (p.online ? '' : ' off');
    dot.title = p.online ? 'в сети' : 'не в сети';
    li.append(av, name, dot);
    if (extra) li.append(extra);
    return li;
  }

  function kickButton(p) {
    if (view.hostId !== view.me || p.id === view.me) return null;
    const b = document.createElement('button');
    b.className = 'btn btn-small btn-ghost btn-danger kick-btn';
    b.textContent = '✕';
    b.title = 'Удалить игрока';
    b.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Удалить игрока «${p.name}» из комнаты?`)) act('kick', { target: p.id });
    };
    return b;
  }

  function renderLobby() {
    $('lobbyCode').textContent = view.room;
    $('lobbyCount').textContent = `${view.players.length} / ${view.limits.max}`;
    const ul = $('lobbyPlayers'); ul.innerHTML = '';
    view.players.forEach((p) => ul.append(playerRow(p, kickButton(p))));
    const isHost = view.hostId === view.me;
    $('startBtn').classList.toggle('hidden', !isHost);
    $('lobbyWait').classList.toggle('hidden', isHost);
    $('startBtn').disabled = view.players.length < view.limits.min;
    $('startBtn').textContent = view.players.length < view.limits.min ? 'Ждём игроков…' : 'Начать игру';
  }

  function renderGame() {
    const me = view.players.find((p) => p.id === view.me) || { name: '', score: 0 };
    const myTurn = view.phase === 'playing' && view.turnId === view.me;
    $('gameCode').textContent = view.room;
    $('roundNo').textContent = view.roundNo;

    // Соперники — по кругу, начиная со следующего после меня
    const opp = $('opponents'); opp.innerHTML = '';
    const myIdx = view.players.findIndex((p) => p.id === view.me);
    const n = view.players.length;
    for (let k = 1; k < n; k++) {
      const p = view.players[(myIdx + k) % n];
      const box = document.createElement('div');
      box.className = 'opp' + (p.id === view.turnId ? ' turn' : '') + (p.online ? '' : ' offline');
      box.dataset.id = p.id;
      const head = document.createElement('div'); head.className = 'opp-head';
      const av = document.createElement('div'); av.className = 'avatar'; av.textContent = p.name[0].toUpperCase();
      const nm = document.createElement('div'); nm.className = 'opp-name'; nm.textContent = p.name + (p.id === view.hostId ? ' 👑' : '');
      const dot = document.createElement('span'); dot.className = 'dot' + (p.online ? '' : ' off');
      head.append(av, nm, dot);
      const kb = p.online ? null : kickButton(p); // в игре удалить можно только отключившегося
      if (kb) head.append(kb);
      const fan = document.createElement('div'); fan.className = 'mini-fan';
      for (let i = 0; i < Math.min(p.count, 12); i++) { const b = document.createElement('div'); b.className = 'mini-back'; fan.append(b); }
      const meta = document.createElement('div'); meta.className = 'opp-meta';
      meta.innerHTML = '';
      const cnt = document.createElement('span'); cnt.textContent = `${p.count} ${plural(p.count, 'карта', 'карты', 'карт')}`;
      const sc = document.createElement('span'); sc.textContent = `${p.score} оч.`;
      meta.append(cnt, sc);
      box.append(head, fan, meta);
      if (p.count === 1 && p.saidUno) {
        const badge = document.createElement('div'); badge.className = 'uno-badge'; badge.textContent = 'UNO!';
        box.append(badge);
      }
      if (p.catchable) {
        const cb = document.createElement('button'); cb.className = 'btn btn-small catch-btn';
        cb.textContent = 'Поймать! (+2)';
        cb.onclick = () => act('catch', { target: p.id });
        box.append(cb);
      }
      opp.append(box);
    }

    // Стол
    const deck = $('deck');
    deck.classList.toggle('can-draw', canDraw());
    $('deckCount').textContent = `в колоде ${view.deckCount}`;
    const disc = $('discard'); disc.innerHTML = '';
    if (view.top) {
      const tc = makeCard(view.top, { chosen: view.currentColor });
      if (view.top.id !== prevTopId) tc.classList.add('pop');
      prevTopId = view.top.id;
      disc.append(tc);
    }
    const badge = $('colorBadge');
    if (view.currentColor) {
      badge.textContent = 'цвет: ' + COLOR_NAMES[view.currentColor];
      badge.style.color = getComputedStyle(document.documentElement).getPropertyValue('--' + view.currentColor);
    }
    $('dirIndicator').classList.toggle('ccw', view.direction < 0);
    if (view.currentColor) $('table').style.setProperty('--glow', `var(--${view.currentColor})`);

    // Статус
    const st = $('status');
    st.classList.toggle('mine', myTurn);
    if (view.phase !== 'playing') st.textContent = 'Раунд окончен';
    else if (myTurn) st.textContent = view.drawnCardId ? 'Взятую карту можно сыграть — или нажмите «Пас»' : 'Ваш ход';
    else {
      const cur = view.players.find((p) => p.id === view.turnId);
      st.textContent = cur ? `Ходит ${cur.name}` + (cur.online ? '' : ` (не в сети — авто-пропуск через ${view.afkSeconds} с)`) : '';
    }

    // Я
    $('meName').textContent = me.name;
    $('meScore').textContent = `${me.score} оч. из ${view.target}`;
    $('drawBtn').classList.toggle('hidden', !myTurn || !!view.drawnCardId);
    $('passBtn').classList.toggle('hidden', !myTurn || !view.drawnCardId);
    $('unoBtn').classList.toggle('hidden', !view.canUno);

    const hand = $('hand'); hand.innerHTML = '';
    const ids = new Set();
    sortHand(view.hand).forEach((c) => {
      const el = makeCard(c);
      ids.add(c.id);
      if (myTurn) el.classList.add(view.playable.includes(c.id) ? 'ok' : 'dim');
      if (prevHandIds.size && !prevHandIds.has(c.id)) el.classList.add('new');
      el.onclick = () => onCardClick(c, el);
      hand.append(el);
    });
    prevHandIds = ids;

    // Индикация хода
    document.body.classList.toggle('my-turn', myTurn);
    document.title = (myTurn ? '▶ Ваш ход — ' : '') + 'UNO онлайн';
    if (!myTurn && pendingWildId) { pendingWildId = null; $('colorPicker').classList.add('hidden'); }

    renderLog();
  }

  function renderLog() {
    const ol = $('log');
    const newest = view.log.length ? view.log[view.log.length - 1].id : 0;
    if (newest === lastLogId) return;
    lastLogId = newest;
    ol.innerHTML = '';
    view.log.slice().reverse().forEach((e) => {
      const li = document.createElement('li');
      if (e.uno) li.className = 'uno';
      const t = document.createElement('span'); t.textContent = e.text;
      li.append(t);
      if (e.card) li.append(makeCard(e.card, { mini: true, chosen: e.color }));
      if (e.color) { const c = document.createElement('span'); c.textContent = '→ ' + COLOR_NAMES[e.color]; li.append(c); }
      ol.append(li);
    });
  }

  function renderRoundOver() {
    const box = $('roundOver');
    if (view.phase !== 'roundOver' || !view.lastRound) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const lr = view.lastRound;
    const winner = view.players.find((p) => p.id === lr.winnerId);
    if (view.gameOver) {
      $('roundTitle').textContent = `🏆 ${lr.winnerName} побеждает в игре!`;
      $('roundSubtitle').textContent = `Набрано ${winner ? winner.score : ''} очков (цель — ${view.target}).`;
    } else {
      $('roundTitle').textContent = `${lr.winnerName} выигрывает раунд!`;
      $('roundSubtitle').textContent = `+${lr.points} ${plural(lr.points, 'очко', 'очка', 'очков')} за карты соперников. Партия идёт до ${view.target}.`;
    }
    const tb = $('scoreBody'); tb.innerHTML = '';
    const rows = view.players.map((p) => ({ p, h: lr.hands.find((h) => h.id === p.id) }))
      .sort((a, b) => b.p.score - a.p.score);
    rows.forEach(({ p, h }) => {
      const tr = document.createElement('tr');
      if (p.id === lr.winnerId) tr.className = 'winner';
      const td1 = document.createElement('td'); td1.textContent = p.name + (p.id === view.me ? ' (вы)' : '');
      const td2 = document.createElement('td'); const cards = document.createElement('div'); cards.className = 'cards';
      if (h && h.cards.length) h.cards.forEach((c) => cards.append(makeCard(c, { mini: true })));
      else cards.textContent = h ? '—' : 'новый игрок';
      td2.append(cards);
      const td3 = document.createElement('td'); td3.textContent = p.id === lr.winnerId ? `+${lr.points}` : (h ? String(h.points) : '');
      const td4 = document.createElement('td'); td4.textContent = p.score;
      tr.append(td1, td2, td3, td4);
      tb.append(tr);
    });
    const isHost = view.hostId === view.me;
    $('nextRoundBtn').classList.toggle('hidden', !isHost);
    $('nextRoundBtn').textContent = view.gameOver ? 'Новая партия' : 'Следующий раунд';
    $('nextRoundBtn').disabled = view.players.length < view.limits.min;
    $('roundWait').classList.toggle('hidden', isHost);
  }

  /* ---------- мелочи ---------- */
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  let toastTimer = null;
  function toast(msg, info) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (info ? ' info' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  /* ---------- запуск ---------- */
  async function init() {
    $('nameInput').value = store.name();
    const urlRoom = (new URL(location.href).searchParams.get('room') || '').toUpperCase();
    if (urlRoom) $('codeInput').value = urlRoom;
    const saved = store.get();
    if (saved && saved.room && saved.token && (!urlRoom || urlRoom === saved.room)) {
      try {
        const data = await api('join', { room: saved.room, token: saved.token, name: saved.name });
        enterRoom(data, saved.name);
        return;
      } catch (e) {
        store.clear();
      }
    }
    show('home');
    if (urlRoom && $('nameInput').value) $('joinBtn').focus();
    else $('nameInput').focus();
  }

  init();
})();
