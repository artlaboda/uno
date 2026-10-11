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
    uno() { tone(880, 0.14, { type: 'square', vol: 0.16 }); tone(1320, 0.3, { type: 'square', vol: 0.16, delay: 0.13 }); },
    caught() { tone(140, 0.4, { type: 'sawtooth', vol: 0.22 }); tone(147, 0.4, { type: 'sawtooth', vol: 0.18 }); },
    myTurn() { tone(1046, 0.5, { vol: 0.22 }); tone(1568, 0.6, { vol: 0.14, delay: 0.09 }); },
    error() { tone(180, 0.12, { type: 'square', vol: 0.12 }); },
    shuffle() { for (let i = 0; i < 8; i++) noise(0.05, { freq: 3000, q: 1.5, vol: 0.25, delay: i * 0.045 }); },
    win() {
      [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, i === 5 ? 0.7 : 0.18, { type: 'triangle', vol: 0.22, delay: i * 0.13 }));
      [262, 330, 392].forEach((f) => tone(f, 1.1, { type: 'sine', vol: 0.1, delay: 0.65 }));
    },
    join() { tone(660, 0.12, { vol: 0.15 }); tone(990, 0.18, { vol: 0.12, delay: 0.08 }); },
  };

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
          const discCard = ctx.discardEl.querySelector('.card');
          const isTop = discCard && e.card && ctx.topId === e.card.id;
          if (isTop) discCard.style.opacity = '0';
          at(start, () => {
            const from = e.by === ctx.me && ctx.playRect ? ctx.playRect : ctx.rectOf(e.by);
            const el = makeCard(e.card, { chosen: e.color });
            const to = ctx.discardEl.getBoundingClientRect();
            fly(el, from, to, { duration: 430, fit: true, fromScale: e.by === ctx.me ? 1 : 0.6 }).then(() => {
              const dc = ctx.discardEl.querySelector('.card');
              if (dc) { dc.style.opacity = ''; dc.classList.remove('pop'); void dc.offsetWidth; dc.classList.add('pop'); }
              sfx.flick();
              const col = e.color ? COLORS[e.color] : COLORS[e.card.color];
              switch (e.card.value) {
                case 'skip': splash('⊘', col, 'ПРОПУСК ХОДА'); sfx.skip(); break;
                case 'reverse': splash('⇄', col, 'РАЗВОРОТ'); sfx.reverse(); break;
                case 'draw2': splash('+2', col); sfx.plus2(); shake(document.body); break;
                case 'wild4': splash('+4', col, COLOR_NAMES[e.color]); sfx.plus4(); wave(col); shake(document.body, true); break;
                case 'wild': splash('★', col, COLOR_NAMES[e.color]); sfx.wild(); wave(col); break;
                default: break;
              }
            });
          });
          t += /^\d$/.test(e.card.value) ? 450 : 750;
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
              shout(ctx.rectOf(e.target), `+${e.n}`, 'bad');
              if (e.target === ctx.me) hurt();
            });
          }
          t += n * 130 + 300;
          break;
        }
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
          at(t, () => { shout(ctx.rectOf(e.by), 'UNO!', 'uno'); sfx.uno(); });
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
    process,
    sfx,
    splash,
    isMuted: () => muted,
    setMuted,
    myTurn() { sfx.myTurn(); },
  };
})();
