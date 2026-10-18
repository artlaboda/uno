'use strict';
/* Эффекты UNO: звуки (синтез через Web Audio, без файлов) и анимации */
window.UnoFX = (() => {
  const COLORS = { red: '#d7263d', yellow: '#f2b705', green: '#1f9d55', blue: '#1e6fd9' };
  const COLOR_NAMES = { red: 'КРАСНЫЙ', yellow: 'ЖЁЛТЫЙ', green: 'ЗЕЛЁНЫЙ', blue: 'СИНИЙ' };
  let layer = null;
  let makeCard = null;

  /* ================= ЗВУК ================= */
  let ac = null;
  let master = null;
  let muted = false;
  try { muted = localStorage.getItem('uno-muted') === '1'; } catch (e) { /* ignore */ }

  function audio() {
    if (muted) return null;
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.55;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  // Браузеры разрешают звук только после первого касания/клика
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, () => audio(), { once: true, passive: true }));

  /* Записанные звуки (mp3): грузятся заранее, играют через общий микшер */
  const samples = {};
  function loadSample(name) {
    if (samples[name] !== undefined) return;
    samples[name] = null;
    fetch('sounds/' + name + '.mp3').then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((buf) => { samples[name] = { buf, decoded: null }; })
      .catch(() => { samples[name] = false; });
  }
  function playSample(name, o = {}) {
    const a = audio(); if (!a) return false;
    const s = samples[name];
    if (!s) return false;
    const go = (decoded) => {
      const src = a.createBufferSource(); src.buffer = decoded;
      src.playbackRate.value = o.rate || 1;
      const g = a.createGain(); g.gain.value = o.vol == null ? 1 : o.vol;
      src.connect(g); g.connect(master);
      src.start(a.currentTime + (o.delay || 0));
    };
    if (s.decoded) { go(s.decoded); return true; }
    a.decodeAudioData(s.buf.slice(0)).then((d) => { s.decoded = d; go(d); }).catch(() => { samples[name] = false; });
    return true;
  }
  loadSample('uno');

  function tone(freq, dur, o = {}) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + (o.delay || 0);
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    const v = o.vol == null ? 0.25 : o.vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + (o.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  let noiseBuf = null;
  function noise(dur, o = {}) {
    const a = audio(); if (!a) return;
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = a.currentTime + (o.delay || 0);
    const src = a.createBufferSource(); src.buffer = noiseBuf;
    const f = a.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 2000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q || 1;
    const g = a.createGain();
    g.gain.setValueAtTime(o.vol == null ? 0.4 : o.vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  const sfx = {
    flick() { noise(0.09, { freq: 2600, q: 0.8, vol: 0.5 }); tone(520, 0.08, { to: 260, type: 'triangle', vol: 0.12 }); },
    draw(delay = 0) { noise(0.16, { freq: 900, to: 3500, q: 0.7, vol: 0.28, delay }); },
    skip() { tone(660, 0.09, { type: 'square', vol: 0.12 }); tone(330, 0.16, { type: 'square', vol: 0.12, delay: 0.1 }); },
    reverse() { tone(300, 0.18, { to: 900, type: 'triangle', vol: 0.2 }); tone(900, 0.18, { to: 300, type: 'triangle', vol: 0.2, delay: 0.18 }); },
    plus2() { tone(160, 0.18, { to: 90, vol: 0.5 }); tone(160, 0.18, { to: 90, vol: 0.5, delay: 0.16 }); },
    plus4() {
      tone(110, 0.6, { to: 38, vol: 0.7 });
      noise(0.5, { filter: 'lowpass', freq: 600, to: 80, vol: 0.6 });
      [0, 0.1, 0.2, 0.3].forEach((d) => tone(180 - d * 200, 0.12, { type: 'sawtooth', vol: 0.08, delay: d }));
    },
    wild() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.18, delay: i * 0.07 })); },
    uno() {
      const a = audio(); if (!a) return;
      if (playSample('uno', { vol: 1.2, rate: 1 + (Math.random() - 0.5) * 0.06 })) {
        // Фанфара поверх записанного выкрика
        [[784, 0], [988, 0.07], [1175, 0.14], [1568, 0.21]].forEach(([f, d]) => tone(f, 0.3, { type: 'triangle', vol: 0.1, delay: d + 0.3 }));
        tone(1568, 0.6, { type: 'triangle', vol: 0.09, delay: 0.62 });
        for (let i = 0; i < 5; i++) tone(2600 + i * 400, 0.09, { type: 'sine', vol: 0.05, delay: 0.7 + i * 0.05 });
        return;
      }
      // Запасной вариант, если mp3 не загрузился
      // «Голос»: пила через две формантные полосы — гласная «У», потом «О»
      const t0 = a.currentTime;
      const say = (f0, vowel, start, dur, vol) => {
        const osc = a.createOscillator(); osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f0, t0 + start);
        osc.frequency.linearRampToValueAtTime(f0 * 1.12, t0 + start + dur * 0.35);
        osc.frequency.linearRampToValueAtTime(f0 * 0.9, t0 + start + dur);
        const vib = a.createOscillator(); vib.frequency.value = 6.5;
        const vg = a.createGain(); vg.gain.value = f0 * 0.03; vib.connect(vg); vg.connect(osc.frequency);
        const env = a.createGain();
        env.gain.setValueAtTime(0.0001, t0 + start);
        env.gain.exponentialRampToValueAtTime(vol, t0 + start + 0.04);
        env.gain.setValueAtTime(vol, t0 + start + dur * 0.7);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        const formants = vowel === 'u' ? [[320, 10], [800, 14], [2500, 20]] : [[500, 9], [1000, 12], [2600, 18]];
        osc.connect(env);
        for (const [fq, q] of formants) {
          const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fq; bp.Q.value = q;
          const g = a.createGain(); g.gain.value = fq < 600 ? 1 : 0.55;
          env.connect(bp); bp.connect(g); g.connect(master);
        }
        osc.start(t0 + start); vib.start(t0 + start);
        osc.stop(t0 + start + dur + 0.05); vib.stop(t0 + start + dur + 0.05);
      };
      say(300, 'u', 0.0, 0.22, 0.9);   // «У»
      say(260, 'o', 0.2, 0.42, 1.0);   // «НО!»
      // Фанфара с «блеском»
      [[784, 0], [988, 0.07], [1175, 0.14], [1568, 0.21]].forEach(([f, d]) => tone(f, 0.35, { type: 'triangle', vol: 0.16, delay: d + 0.05 }));
      tone(1568, 0.7, { type: 'triangle', vol: 0.14, delay: 0.42 });
      tone(392, 0.7, { type: 'sawtooth', vol: 0.06, delay: 0.42 });
      for (let i = 0; i < 5; i++) tone(2600 + i * 400, 0.09, { type: 'sine', vol: 0.07, delay: 0.5 + i * 0.05 });
      noise(0.25, { freq: 6000, q: 0.5, vol: 0.08, delay: 0.45 });
    },
    emote(kind) {
      switch (kind) {
        case 'angry': tone(90, 0.5, { type: 'sawtooth', vol: 0.3, to: 60 }); noise(0.4, { filter: 'lowpass', freq: 400, vol: 0.5 }); for (let i = 0; i < 4; i++) tone(120 + i * 15, 0.08, { type: 'square', vol: 0.12, delay: 0.1 + i * 0.09 }); break;
        case 'laugh': for (let i = 0; i < 6; i++) { tone(520 - i * 35, 0.11, { type: 'square', vol: 0.12, delay: i * 0.13 }); noise(0.07, { freq: 1500, q: 1, vol: 0.2, delay: i * 0.13 }); } break;
        case 'joy': [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.2, { type: 'triangle', vol: 0.18, delay: i * 0.08 })); tone(1318, 0.5, { type: 'triangle', vol: 0.15, delay: 0.32 }); noise(0.3, { freq: 7000, q: 0.5, vol: 0.08, delay: 0.3 }); break;
        case 'cool': tone(220, 0.3, { type: 'sawtooth', vol: 0.12, to: 180 }); tone(330, 0.35, { type: 'sawtooth', vol: 0.1, delay: 0.25, to: 300 }); break;
        case 'shock': tone(1200, 0.08, { type: 'square', vol: 0.14 }); tone(1600, 0.4, { type: 'square', vol: 0.12, delay: 0.08, to: 2200 }); break;
        case 'think': [0, 0.25, 0.5].forEach((d) => tone(660, 0.1, { type: 'sine', vol: 0.12, delay: d })); break;
        case 'cry': tone(600, 0.5, { type: 'sine', vol: 0.15, to: 300 }); tone(560, 0.5, { type: 'sine', vol: 0.12, to: 280, delay: 0.45 }); break;
        case 'love': [659, 784, 988, 1175].forEach((f, i) => tone(f, 0.28, { type: 'sine', vol: 0.14, delay: i * 0.1 })); break;
        default: break;
      }
    },
    caught() { tone(140, 0.4, { type: 'sawtooth', vol: 0.22 }); tone(147, 0.4, { type: 'sawtooth', vol: 0.18 }); },
    myTurn() { tone(1046, 0.5, { vol: 0.22 }); tone(1568, 0.6, { vol: 0.14, delay: 0.09 }); },
    error() { tone(180, 0.12, { type: 'square', vol: 0.12 }); },
    shuffle() { for (let i = 0; i < 8; i++) noise(0.05, { freq: 3000, q: 1.5, vol: 0.25, delay: i * 0.045 }); },
    win() {
      [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, i === 5 ? 0.7 : 0.18, { type: 'triangle', vol: 0.22, delay: i * 0.13 }));
      [262, 330, 392].forEach((f) => tone(f, 1.1, { type: 'sine', vol: 0.1, delay: 0.65 }));
    },
    join() { tone(660, 0.12, { vol: 0.15 }); tone(990, 0.18, { vol: 0.12, delay: 0.08 }); },
    jump() { tone(400, 0.08, { type: 'square', vol: 0.14, to: 1200 }); tone(1200, 0.18, { type: 'square', vol: 0.12, delay: 0.07, to: 1800 }); noise(0.12, { freq: 4000, q: 0.8, vol: 0.25 }); },
    whoosh() { noise(0.28, { freq: 500, to: 2600, q: 0.6, vol: 0.18 }); },
    thud() { tone(140, 0.12, { to: 70, vol: 0.35 }); noise(0.06, { freq: 1800, q: 0.7, vol: 0.4 }); },
    tick(hard) { tone(hard ? 1400 : 1000, 0.05, { type: 'square', vol: hard ? 0.14 : 0.08 }); },
    timeup() {
      for (let i = 0; i < 6; i++) { tone(1320, 0.08, { type: 'square', vol: 0.14, delay: i * 0.12 }); }
      tone(220, 0.6, { type: 'sawtooth', vol: 0.12, delay: 0.75 });
    },
  };

  /* ================= СТОПКА СБРОСА ================= */
  // Положение карты в стопке вычисляется из её id — у всех игроков стопка выглядит одинаково
  function hash(str, seed) {
    let h = 2166136261 ^ seed;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967295;
  }
  function pileTransform(id) {
    return {
      r: Math.round((hash(id, 1) * 2 - 1) * 32),
      x: Math.round((hash(id, 2) * 2 - 1) * 12),
      y: Math.round((hash(id, 3) * 2 - 1) * 9),
    };
  }

  /* ================= АНИМАЦИИ ================= */
  function ensureLayer() {
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'fx-layer';
      document.body.append(layer);
    }
    return layer;
  }

  function backCard() {
    const el = document.createElement('div');
    el.className = 'card back';
    const s = document.createElement('span'); s.className = 'back-label'; s.textContent = 'UNO';
    el.append(s);
    return el;
  }

  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  // Полёт карты из одной точки экрана в другую
  function fly(el, fromRect, toRect, o = {}) {
    ensureLayer();
    const wrap = document.createElement('div');
    wrap.className = 'fx-fly';
    wrap.append(el);
    layer.append(wrap);
    const w = el.offsetWidth, h = el.offsetHeight;
    const a = center(fromRect), b = center(toRect);
    const rot = o.rotate == null ? (Math.random() * 40 - 20) : o.rotate;
    const s0 = o.fromScale || 1;
    const s1 = o.fit && w ? toRect.width / w : (o.toScale || 1);
    const midX = (a.x + b.x) / 2, midY = Math.min(a.y, b.y) - (o.arc == null ? 60 : o.arc);
    const anim = wrap.animate([
      { transform: `translate(${a.x - w / 2}px, ${a.y - h / 2}px) rotate(0deg) scale(${s0})`, opacity: o.fadeIn ? 0 : 1 },
      { transform: `translate(${midX - w / 2}px, ${midY - h / 2}px) rotate(${rot / 2}deg) scale(${(s0 + s1) / 2 * 1.12})`, opacity: 1, offset: 0.5 },
      { transform: `translate(${b.x - w / 2}px, ${b.y - h / 2}px) rotate(${rot}deg) scale(${s1})`, opacity: o.fadeOut ? 0 : 1 },
    ], { duration: o.duration || 420, delay: o.delay || 0, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' });
    return anim.finished.then(() => wrap.remove(), () => wrap.remove());
  }

  // Бросок карты в стопку: каждый раз своя траектория, вращение и переворот
  function throwCard(card, chosen, fromRect, pileEl, o = {}) {
    ensureLayer();
    const pileRect = pileEl.getBoundingClientRect();
    const W = pileRect.width, H = pileRect.height;
    const wrap = document.createElement('div');
    wrap.className = 'fx-fly fx-throw';
    wrap.style.width = W + 'px'; wrap.style.height = H + 'px';
    const inner = document.createElement('div'); inner.className = 'fx-3d';
    const front = makeCard(card, { chosen }); front.classList.add('pile-card', 'face');
    const back = backCard(); back.classList.add('pile-card', 'rear');
    inner.append(front, back);
    wrap.append(inner);
    layer.append(wrap);

    const R = Math.random;
    const pick = (arr) => arr[Math.floor(R() * arr.length)];
    const style = o.faceDown ? pick(['flip', 'flip', 'arc', 'spin']) : pick(['arc', 'flick', 'spin', 'lob', 'flip']);
    const t = pileTransform(card.id);
    const a = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
    const b = { x: pileRect.left + W / 2 + t.x, y: pileRect.top + H / 2 + t.y };
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist, ny = dx / dist;                       // перпендикуляр к линии броска
    const side = R() < 0.5 ? -1 : 1;
    const bend = { arc: 0.35, flick: 0.12, spin: 0.25, lob: 0.15, flip: 0.3 }[style] * dist * (0.6 + R() * 0.8) * side;
    const lift = { arc: 60, flick: 10, spin: 40, lob: 160, flip: 90 }[style] * (0.7 + R() * 0.6);
    const c = { x: (a.x + b.x) / 2 + nx * bend, y: (a.y + b.y) / 2 + ny * bend - lift };

    const s0 = Math.max(0.35, Math.min(1.2, fromRect.width / W));
    const peak = { arc: 1.25, flick: 1.08, spin: 1.2, lob: 1.45, flip: 1.3 }[style];
    const r0 = (R() * 2 - 1) * 25;
    const spins = { arc: pick([0, 0, 1]), flick: pick([0, 1, -1]), spin: pick([1, -1, 2, -2]), lob: pick([0, 1]), flip: 0 }[style];
    const r1 = t.r + spins * 360;
    const ry0 = o.faceDown ? 180 : (style === 'flip' ? -360 : 0);  // карта соперника летит рубашкой и переворачивается
    const rx = style === 'lob' ? 35 : (style === 'flick' ? 0 : 18);
    const dur = { arc: 560, flick: 380, spin: 600, lob: 720, flip: 640 }[style] * (0.85 + R() * 0.3);

    const N = 16, frames = [], ff = [], bf = [];
    for (let i = 0; i <= N; i++) {
      const k = i / N, m = 1 - k;
      const x = m * m * a.x + 2 * m * k * c.x + k * k * b.x;
      const y = m * m * a.y + 2 * m * k * c.y + k * k * b.y;
      const bump = Math.sin(Math.PI * k);
      const sc = s0 + (1 - s0) * k + (peak - 1) * bump;
      const rz = r0 + (r1 - r0) * k;
      const ry = ry0 * (1 - Math.min(1, k * 1.5));
      const rxx = rx * bump;
      frames.push({
        offset: k,
        transform: `translate(${x - W / 2}px, ${y - H / 2}px) perspective(900px) rotateZ(${rz}deg) rotateY(${ry}deg) rotateX(${rxx}deg) scale(${sc})`,
        filter: `drop-shadow(0 ${8 + 30 * bump}px ${10 + 18 * bump}px rgba(0,0,0,${0.35 + 0.15 * bump}))`,
      });
      // какая сторона карты видна при данном повороте
      const faceUp = Math.cos(ry * Math.PI / 180) >= 0;
      ff.push({ offset: k, opacity: faceUp ? 1 : 0 });
      bf.push({ offset: k, opacity: faceUp ? 0 : 1 });
    }
    const ease = { arc: 'cubic-bezier(.25,.6,.3,1)', flick: 'cubic-bezier(.1,.8,.2,1)', spin: 'cubic-bezier(.3,.5,.25,1)', lob: 'cubic-bezier(.35,.2,.3,1)', flip: 'cubic-bezier(.3,.6,.3,1)' }[style];
    sfx.whoosh();
    const timing = { duration: dur, easing: ease, fill: 'both' };
    front.animate(ff, timing);
    back.animate(bf, timing);
    return wrap.animate(frames, timing)
      .finished.then(() => wrap.remove(), () => wrap.remove());
  }

  // Карта «впечатывается» в стопку
  function land(pileEl) {
    const top = pileEl.querySelector('.pile-card:last-child');
    if (top) {
      const base = top.style.transform || '';
      top.style.visibility = '';
      top.animate([
        { transform: base + ' scale(1.14)', filter: 'brightness(1.25)' },
        { transform: base + ' scale(.97)', offset: 0.55 },
        { transform: base + ' scale(1)', filter: 'brightness(1)' },
      ], { duration: 260, easing: 'ease-out' });
    }
    pileEl.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(3px)' }, { transform: 'translateY(0)' }], { duration: 180 });
    sfx.thud();
  }

  // Крупная надпись по центру экрана
  function splash(text, color, sub) {
    ensureLayer();
    const el = document.createElement('div');
    el.className = 'fx-splash';
    const big = document.createElement('div'); big.className = 'fx-splash-big'; big.textContent = text;
    if (color) big.style.color = color;
    el.append(big);
    if (sub) { const s = document.createElement('div'); s.className = 'fx-splash-sub'; s.textContent = sub; el.append(s); }
    layer.append(el);
    el.animate([
      { transform: 'translate(-50%,-50%) scale(.2) rotate(-12deg)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.18) rotate(3deg)', opacity: 1, offset: 0.22 },
      { transform: 'translate(-50%,-50%) scale(1) rotate(0)', opacity: 1, offset: 0.4 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.75 },
      { transform: 'translate(-50%,-50%) scale(1.4)', opacity: 0 },
    ], { duration: 1100, easing: 'ease-out', fill: 'both' }).finished.then(() => el.remove(), () => el.remove());
  }

  // Цветная волна по экрану (смена цвета)
  function wave(color) {
    ensureLayer();
    const el = document.createElement('div');
    el.className = 'fx-wave';
    el.style.setProperty('--c', color);
    layer.append(el);
    el.animate([
      { transform: 'translate(-50%,-50%) scale(0)', opacity: 0.85 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 },
    ], { duration: 900, easing: 'cubic-bezier(.2,.7,.3,1)' }).finished.then(() => el.remove(), () => el.remove());
  }

  // Красная вспышка по краям экрана (штраф для меня)
  function hurt() {
    ensureLayer();
    const el = document.createElement('div');
    el.className = 'fx-hurt';
    layer.append(el);
    el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 800 })
      .finished.then(() => el.remove(), () => el.remove());
    if (navigator.vibrate) { try { navigator.vibrate([60, 40, 120]); } catch (e) { /* ignore */ } }
  }

  // Выкрик над игроком
  function shout(rect, text, cls) {
    if (!rect) return;
    ensureLayer();
    const el = document.createElement('div');
    el.className = 'fx-shout ' + (cls || '');
    el.textContent = text;
    layer.append(el);
    const c = center(rect);
    el.style.left = c.x + 'px';
    el.style.top = (rect.top + 10) + 'px';
    el.animate([
      { transform: 'translate(-50%,-50%) scale(.2) rotate(-10deg)', opacity: 0 },
      { transform: 'translate(-50%,-80%) scale(1.25) rotate(4deg)', opacity: 1, offset: 0.2 },
      { transform: 'translate(-50%,-90%) scale(1) rotate(-2deg)', opacity: 1, offset: 0.7 },
      { transform: 'translate(-50%,-150%) scale(.9)', opacity: 0 },
    ], { duration: 1300, easing: 'ease-out', fill: 'both' }).finished.then(() => el.remove(), () => el.remove());
  }

  const EMOJI = { angry: '😡', laugh: '😂', joy: '🥳', cool: '😎', shock: '😱', think: '🤔', cry: '😭', love: '😍' };
  function emote(kind, rect, isMe) {
    if (!rect) return;
    ensureLayer();
    const cx = rect.left + rect.width / 2;
    const cy = isMe ? rect.top + rect.height * 0.35 : rect.top + rect.height / 2;
    const el = document.createElement('div');
    el.className = 'fx-emote';
    el.textContent = EMOJI[kind] || '🙂';
    el.style.left = cx + 'px'; el.style.top = cy + 'px';
    layer.append(el);
    const base = 'translate(-50%,-50%)';
    const anims = {
      angry: [
        { transform: base + ' scale(.2)', opacity: 0, filter: 'none' },
        { transform: base + ' scale(1.6)', opacity: 1, offset: 0.15 },
        { transform: base + ' scale(1.4) translateX(-8px) rotate(-8deg)', offset: 0.3 },
        { transform: base + ' scale(1.5) translateX(8px) rotate(8deg)', offset: 0.45, filter: 'drop-shadow(0 0 18px #ff2020)' },
        { transform: base + ' scale(1.4) translateX(-8px) rotate(-6deg)', offset: 0.6 },
        { transform: base + ' scale(1.6) translateX(6px) rotate(6deg)', offset: 0.75, filter: 'drop-shadow(0 0 24px #ff2020)' },
        { transform: base + ' scale(2.2)', opacity: 0 },
      ],
      laugh: [
        { transform: base + ' scale(.3) rotate(0)', opacity: 0 },
        { transform: base + ' scale(1.4) rotate(-15deg)', opacity: 1, offset: 0.15 },
        { transform: base + ' scale(1.2) rotate(15deg) translateY(-10px)', offset: 0.3 },
        { transform: base + ' scale(1.45) rotate(-15deg) translateY(6px)', offset: 0.45 },
        { transform: base + ' scale(1.2) rotate(15deg) translateY(-10px)', offset: 0.6 },
        { transform: base + ' scale(1.45) rotate(-12deg) translateY(6px)', offset: 0.75 },
        { transform: base + ' scale(1) translateY(-60px)', opacity: 0 },
      ],
      joy: [
        { transform: base + ' scale(.2) translateY(40px)', opacity: 0 },
        { transform: base + ' scale(1.6) translateY(-30px) rotate(-10deg)', opacity: 1, offset: 0.25 },
        { transform: base + ' scale(1.3) translateY(0) rotate(10deg)', offset: 0.45 },
        { transform: base + ' scale(1.6) translateY(-30px) rotate(-10deg)', offset: 0.65 },
        { transform: base + ' scale(1.3) translateY(0)', offset: 0.8 },
        { transform: base + ' scale(2) translateY(-80px)', opacity: 0 },
      ],
      cool: [
        { transform: base + ' scale(.5) translateY(-40px)', opacity: 0 },
        { transform: base + ' scale(1.5)', opacity: 1, offset: 0.2 },
        { transform: base + ' scale(1.5) rotate(-6deg)', offset: 0.5 },
        { transform: base + ' scale(1.5) rotate(6deg)', offset: 0.8 },
        { transform: base + ' scale(1.2) translateX(120px)', opacity: 0 },
      ],
      shock: [
        { transform: base + ' scale(.2)', opacity: 0 },
        { transform: base + ' scale(2.1)', opacity: 1, offset: 0.12 },
        { transform: base + ' scale(1.5) translateX(-6px)', offset: 0.3 },
        { transform: base + ' scale(1.6) translateX(6px)', offset: 0.4 },
        { transform: base + ' scale(1.5) translateX(-6px)', offset: 0.5 },
        { transform: base + ' scale(1.6)', offset: 0.8 },
        { transform: base + ' scale(.3)', opacity: 0 },
      ],
      think: [
        { transform: base + ' scale(.4)', opacity: 0 },
        { transform: base + ' scale(1.3) rotate(-8deg)', opacity: 1, offset: 0.2 },
        { transform: base + ' scale(1.3) rotate(8deg) translateY(-6px)', offset: 0.5 },
        { transform: base + ' scale(1.3) rotate(-8deg)', offset: 0.8 },
        { transform: base + ' scale(1) translateY(-40px)', opacity: 0 },
      ],
      cry: [
        { transform: base + ' scale(.4)', opacity: 0 },
        { transform: base + ' scale(1.4)', opacity: 1, offset: 0.2 },
        { transform: base + ' scale(1.35) translateY(4px) rotate(-4deg)', offset: 0.4 },
        { transform: base + ' scale(1.4) translateY(0) rotate(4deg)', offset: 0.6 },
        { transform: base + ' scale(1.35) translateY(4px)', offset: 0.8 },
        { transform: base + ' scale(1) translateY(50px)', opacity: 0 },
      ],
      love: [
        { transform: base + ' scale(.3)', opacity: 0 },
        { transform: base + ' scale(1.5)', opacity: 1, offset: 0.2 },
        { transform: base + ' scale(1.3)', offset: 0.4 },
        { transform: base + ' scale(1.6)', offset: 0.55 },
        { transform: base + ' scale(1.3)', offset: 0.7 },
        { transform: base + ' scale(1.4) translateY(-70px)', opacity: 0 },
      ],
    };
    el.animate(anims[kind] || anims.think, { duration: kind === 'laugh' || kind === 'angry' ? 1700 : 1500, easing: 'ease-in-out', fill: 'both' })
      .finished.then(() => el.remove(), () => el.remove());
    // Частицы вокруг
    const particles = { angry: ['💢', '🔥', '💢'], laugh: ['ХА', 'ХА', 'ХА', 'ХА'], joy: ['🎉', '✨', '🎊', '⭐'], cool: ['✨'], shock: ['❗', '❗'], think: ['❓', '💭'], cry: ['💧', '💧', '💧'], love: ['❤️', '💕', '❤️'] }[kind] || [];
    particles.forEach((txt, i) => {
      const p = document.createElement('div');
      p.className = 'fx-particle' + (txt.length > 1 && /[А-Я]/.test(txt) ? ' text' : '');
      p.textContent = txt;
      p.style.left = cx + 'px'; p.style.top = cy + 'px';
      layer.append(p);
      const ang = (i / particles.length) * Math.PI * 2 + Math.random() * 0.8;
      const d = 50 + Math.random() * 50;
      p.animate([
        { transform: 'translate(-50%,-50%) scale(.3)', opacity: 0 },
        { transform: `translate(calc(-50% + ${Math.cos(ang) * d * 0.6}px), calc(-50% + ${Math.sin(ang) * d * 0.6 - 20}px)) scale(1.2) rotate(${(Math.random() - 0.5) * 40}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate(calc(-50% + ${Math.cos(ang) * d}px), calc(-50% + ${Math.sin(ang) * d - 60}px)) scale(.8)`, opacity: 0 },
      ], { duration: 1300, delay: 150 + i * 90, easing: 'ease-out', fill: 'both' }).finished.then(() => p.remove(), () => p.remove());
    });
    if (kind === 'angry') { shake(document.body, false); if (isMe) hurt(); }
    if (kind === 'joy' && isMe) confetti(1800);
    sfx.emote(kind);
  }

  function shake(el, strong) {
    if (!el) return;
    const d = strong ? 12 : 6;
    el.animate([
      { transform: 'translateX(0)' }, { transform: `translateX(-${d}px) rotate(-1deg)` },
      { transform: `translateX(${d}px) rotate(1deg)` }, { transform: `translateX(-${d / 2}px)` },
      { transform: 'translateX(0)' },
    ], { duration: strong ? 450 : 320 });
  }

  function confetti(ms = 3500) {
    ensureLayer();
    const cv = document.createElement('canvas');
    cv.className = 'fx-confetti';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    layer.append(cv);
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const cols = Object.values(COLORS).concat(['#ffffff']);
    const parts = Array.from({ length: 170 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120,
      y: innerHeight * 0.45,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 17 - 6,
      w: 6 + Math.random() * 8, h: 4 + Math.random() * 6,
      r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      c: cols[Math.floor(Math.random() * cols.length)],
    }));
    const start = performance.now();
    (function frame(now) {
      const t = now - start;
      g.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.38; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r);
        g.globalAlpha = Math.max(0, 1 - t / ms);
        g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        g.restore();
      }
      if (t < ms) requestAnimationFrame(frame); else cv.remove();
    })(start);
  }

  /* ================= ОБРАБОТКА СОБЫТИЙ ИГРЫ ================= */
  // ctx: { me, nameOf(id), rectOf(id), boxOf(id), deckEl, discardEl, dirEl, playRect }
  // Возвращает длительность анимаций в мс
  function process(entries, ctx) {
    let t = 0;
    const at = (ms, fn) => setTimeout(fn, ms);
    const deckRect = () => ctx.deckEl.getBoundingClientRect();

    for (const e of entries) {
      switch (e.fx) {
        case 'play': {
          const start = t;
          const isTop = e.card && ctx.topId === e.card.id;
          const topEl = isTop ? ctx.discardEl.querySelector('.pile-card:last-child') : null;
          if (topEl) topEl.style.visibility = 'hidden';
          let flightMs = 600;
          at(start, () => {
            const mine = e.by === ctx.me;
            const from = mine && ctx.playRect ? ctx.playRect : ctx.rectOf(e.by);
            throwCard(e.card, e.color, from, ctx.discardEl, { faceDown: !mine }).then(() => {
              if (topEl) land(ctx.discardEl);
              const col = e.color ? COLORS[e.color] : COLORS[e.card.color];
              switch (e.card.value) {
                case 'skip': splash('⊘', col, 'ПРОПУСК ХОДА'); sfx.skip(); break;
                case 'reverse': splash('⇄', col, 'РАЗВОРОТ'); sfx.reverse(); break;
                case 'draw2':
                  splash(e.stack ? `+${e.stack}` : '+2', col, e.stacked ? 'ПЕРЕВОД!' : null);
                  sfx.plus2(); if (e.stacked) sfx.plus2(); shake(document.body, !!e.stacked);
                  break;
                case 'wild4':
                  splash(e.stack ? `+${e.stack}` : '+4', col, (e.stacked ? 'ПЕРЕВОД! ' : '') + COLOR_NAMES[e.color]);
                  sfx.plus4(); wave(col); shake(document.body, true);
                  break;
                case 'wild': splash('★', col, COLOR_NAMES[e.color]); sfx.wild(); wave(col); break;
                default: break;
              }
            });
          });
          t += /^\d$/.test(e.card.value) ? flightMs + 50 : flightMs + 350;
          break;
        }
        case 'draw': {
          const n = Math.min(e.n || 0, 8);
          const start = t;
          for (let i = 0; i < n; i++) {
            at(start + i * 130, () => {
              const to = e.target === ctx.me ? ctx.handRect() : ctx.rectOf(e.target);
              fly(backCard(), deckRect(), to, { duration: 420, toScale: e.target === ctx.me ? 1 : 0.5, rotate: Math.random() * 30 - 15, arc: 30, fadeOut: e.target !== ctx.me });
              sfx.draw();
            });
          }
          if (e.penalty) {
            at(start, () => {
              shout(ctx.rectOf(e.target), e.turnup ? '⏱ Время!' : `+${e.n}`, 'bad');
              if (e.turnup) sfx.error();
              if (e.target === ctx.me) hurt();
            });
          }
          t += n * 130 + 300;
          break;
        }
        case 'stack':
          at(t, () => {
            shout(ctx.rectOf(e.target), `+${e.n}?`, 'bad');
            shake(ctx.boxOf(e.target));
            if (e.target === ctx.me && navigator.vibrate) { try { navigator.vibrate([40, 30, 40]); } catch (err) { /* ignore */ } }
          });
          t += 250;
          break;
        case 'skip':
          at(t, () => { shout(ctx.rectOf(e.target), '⊘', 'bad'); shake(ctx.boxOf(e.target)); });
          t += 250;
          break;
        case 'reverse':
          at(t, () => {
            if (ctx.dirEl) ctx.dirEl.animate([{ transform: 'rotate(0) scale(1)' }, { transform: 'rotate(360deg) scale(1.6)' }, { transform: 'rotate(720deg) scale(1)' }], { duration: 800, easing: 'ease-in-out' });
            if (e.target) shout(ctx.rectOf(e.target), '⊘', 'bad');
          });
          break;
        case 'uno':
          at(t, () => {
            shout(ctx.rectOf(e.by), 'UNO!', 'uno');
            sfx.uno();
            if (e.by === ctx.me) splash('UNO!', '#d7263d');
          });
          t += 300;
          break;
        case 'jump':
          at(t, () => {
            shout(ctx.rectOf(e.by), '⚡ Перехват!', 'jump');
            sfx.jump();
            shake(ctx.boxOf(e.target));
          });
          t += 250;
          break;
        case 'emote':
          at(t, () => emote(e.emote, e.by === ctx.me ? ctx.boxOf(ctx.me).getBoundingClientRect() : ctx.rectOf(e.by), e.by === ctx.me));
          break;
        case 'turnup':
          at(t, () => { shout(ctx.rectOf(e.target), '⏱ Время!', 'bad'); sfx.timeup(); });
          t += 300;
          break;
        case 'catch': {
          at(t, () => { shout(ctx.rectOf(e.target), 'Попался!', 'bad'); sfx.caught(); shake(ctx.boxOf(e.target), true); if (e.target === ctx.me) hurt(); });
          const start = t + 300;
          for (let i = 0; i < 2; i++) {
            at(start + i * 140, () => {
              const to = e.target === ctx.me ? ctx.handRect() : ctx.rectOf(e.target);
              fly(backCard(), deckRect(), to, { duration: 420, toScale: e.target === ctx.me ? 1 : 0.5, arc: 30, fadeOut: e.target !== ctx.me });
              sfx.draw();
            });
          }
          t += 700;
          break;
        }
        case 'shuffle':
          at(t, () => { shake(ctx.deckEl, true); sfx.shuffle(); });
          t += 400;
          break;
        case 'deal': {
          const ids = ctx.playerIds();
          let k = 0;
          for (let r = 0; r < 4; r++) {
            for (const id of ids) {
              const d = k++ * 55;
              at(t + d, () => {
                const to = id === ctx.me ? ctx.handRect() : ctx.rectOf(id);
                fly(backCard(), deckRect(), to, { duration: 380, toScale: id === ctx.me ? 1 : 0.5, arc: 20, fadeOut: true });
                if (k % 2 === 0) sfx.draw();
              });
            }
          }
          at(t, () => sfx.shuffle());
          t += k * 55 + 400;
          break;
        }
        case 'timeup':
          at(t, () => { splash('⏰', '#ffffff', 'ВРЕМЯ ВЫШЛО'); sfx.timeup(); shake(document.body, true); });
          t += 900;
          break;
        case 'win':
          at(t, () => {
            confetti(e.game ? 5000 : 3500);
            sfx.win();
            if (e.game) setTimeout(() => confetti(4000), 1200);
          });
          t += 300;
          break;
        default:
          break;
      }
    }
    return t;
  }

  function setMuted(v) {
    muted = v;
    try { localStorage.setItem('uno-muted', v ? '1' : '0'); } catch (e) { /* ignore */ }
    if (!v) audio();
  }

  return {
    setCardFactory(fn) { makeCard = fn; },
    pileTransform,
    process,
    sfx,
    splash,
    isMuted: () => muted,
    setMuted,
    myTurn() { sfx.myTurn(); },
  };
})();
