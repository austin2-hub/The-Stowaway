(() => {
  // Example name in the name box: a random common British or US first name.
  const EXAMPLE_NAMES = ['Oliver', 'Amelia', 'Harry', 'Isla', 'George', 'Poppy', 'Alfie', 'Freya', 'Jack', 'Ella', 'Ethan', 'Madison', 'Tyler', 'Hannah', 'Logan', 'Avery', 'Mason', 'Chloe', 'Carter', 'Brooke'];
  document.getElementById('name').placeholder = `e.g. ${EXAMPLE_NAMES[Math.floor(Math.random() * EXAMPLE_NAMES.length)]}`;
  // Example room code under the code box, using the same letters real codes use.
  const EXAMPLE_CODE = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
  document.getElementById('code').placeholder = EXAMPLE_CODE;
  document.querySelectorAll('[data-example-code]').forEach(el => { el.textContent = EXAMPLE_CODE; });
  const $ = (sel, root = document) => root.querySelector(sel);
  const boarding = $('#boarding'), play = $('#play'), toastEl = $('#toast'), announcer = $('#announcer');
  const STORE = 'stowaway-session';
  history.scrollRestoration = 'manual';

  let ws = null, state = null, offset = 0, retries = 0, retryTimer = null, leaving = false, silentJoin = false;
  let viewKey = null, lastSecond = null, toastTimer = null;
  let saved = load();

  function load() { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } }
  function persist() { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch {} }
  function forget() { saved = { name: saved.name }; persist(); }
  const now = () => Date.now() + offset;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const player = id => state?.players.find(p => p.id === id);
  const nameOf = id => player(id)?.name || 'A passenger';
  const me = () => player(state?.me?.id);
  const isHost = () => state?.hostId === state?.me?.id;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const pad = n => String(n).padStart(2, '0');

  // ---------- Sound: synthesised in the browser, no audio files ----------
  const sound = (() => {
    let ctx = null, on = localStorage.getItem('stowaway-sound') !== 'off';
    const btn = $('#sound-toggle');
    const paint = () => { btn.setAttribute('aria-pressed', String(on)); btn.setAttribute('aria-label', on ? 'Sound on' : 'Sound off'); btn.classList.toggle('muted', !on); };
    paint();
    btn.addEventListener('click', () => { on = !on; try { localStorage.setItem('stowaway-sound', on ? 'on' : 'off'); } catch {} paint(); if (on) play('chime'); });
    function audio() { if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); } if (ctx.state === 'suspended') ctx.resume(); return ctx; }
    function tone(freq, start, dur, type = 'sine', gain = 0.12, to = null) {
      const a = audio(); if (!a) return;
      const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + start;
      o.type = type; o.frequency.setValueAtTime(freq, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
    }
    function horn() {
      const a = audio(); if (!a) return;
      const filter = a.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 520; filter.connect(a.destination);
      for (const f of [98, 123.5]) {
        const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
        o.type = 'sawtooth'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.18); g.gain.setValueAtTime(0.09, t + 1.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        o.connect(g).connect(filter); o.start(t); o.stop(t + 1.7);
      }
    }
    function play(name) {
      if (!on) return;
      try {
        if (name === 'horn') horn();
        if (name === 'stamp') { tone(140, 0, 0.18, 'square', 0.14, 50); tone(70, 0.01, 0.25, 'sine', 0.2, 40); }
        if (name === 'tick') tone(1400, 0, 0.04, 'square', 0.03);
        if (name === 'chime') { tone(880, 0, 0.35, 'sine', 0.08); tone(1320, 0.12, 0.45, 'sine', 0.06); }
        if (name === 'turn') { tone(660, 0, 0.18, 'triangle', 0.1); tone(990, 0.16, 0.3, 'triangle', 0.09); }
        if (name === 'reject') tone(180, 0, 0.22, 'sawtooth', 0.06, 120);
        if (name === 'send') tone(520, 0, 0.12, 'triangle', 0.08, 780);
        if (name === 'pop') tone(880, 0, 0.08, 'triangle', 0.07, 1320);
        if (name === 'badge') { tone(784, 0, 0.25, 'triangle', 0.08); tone(1175, 0.12, 0.45, 'triangle', 0.08); tone(1568, 0.26, 0.5, 'sine', 0.05); }
        if (name === 'levelup') { horn(); [523, 784, 1047].forEach((f, i) => tone(f, 0.5 + i * 0.12, 0.5, 'triangle', 0.07)); }
        if (name === 'win') { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.4, 'triangle', 0.08)); }
      } catch {}
    }
    return { play };
  })();
  const buzz = pattern => { try { navigator.vibrate?.(pattern); } catch {} };

  // ---------- Passport, ranks and badges (fx.js) ----------
  const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    eye: icon('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 4a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'),
    star: icon('M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z'),
    mask: icon('M12 2C7 2 4 6 4 11v11l3-2 2.5 2 2.5-2 2.5 2 2.5-2 3 2V11c0-5-3-9-8-9zM9 9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z'),
    bulb: icon('M9 21h6v-2H9zm3-19a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z'),
    copy: icon('M8 2h11v14H8zM4 6h2v14h11v2H4z'),
    ticket: icon('M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4z'),
    helm: icon('M12 1l1.5 4.1a7 7 0 0 1 3.7 2.1L21.5 6l-1.6 4a7 7 0 0 1 0 4l1.6 4-4.3-1.2a7 7 0 0 1-3.7 2.1L12 23l-1.5-4.1a7 7 0 0 1-3.7-2.1L2.5 18l1.6-4a7 7 0 0 1 0-4l-1.6-4 4.3 1.2a7 7 0 0 1 3.7-2.1zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'),
    anchor: icon('M12 2a3 3 0 0 1 1 5.8V10h4v2h-4v7.9A7 7 0 0 0 19 14h-2l3-4 3 4h-2a9 9 0 0 1-18 0H1l3-4 3 4H5a7 7 0 0 0 6 5.9V12H7v-2h4V7.8A3 3 0 0 1 12 2zm0 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z'),
  };
  FX.setup({
    key: 'stowaway', sound: name => sound.play(name), cardTitle: 'PASSENGER RANK', levelKicker: 'PROMOTED ON DECK', badgeKicker: 'PASSPORT STAMP', badgeShelf: 'PASSPORT STAMPS',
    ranks: ['Deckhand', 'Steward', 'Bosun', 'Navigator', 'First Mate', 'Captain', 'Commodore', 'Harbourmaster', 'Admiral of the Night'],
    statLabels: { games: 'Voyages', wins: 'Captaincies', caught: 'Stowaways caught', escapes: 'Escapes' },
    particles: ['<i class="pt pt-ticket"></i>', '<i class="pt pt-brass"></i>', '<i class="pt pt-ticket red"></i>', '<i class="pt pt-dot"></i>'],
    badges: {
      'first-catch': { name: 'First Catch', desc: 'Vote for the stowaway.', icon: ICONS.eye, xp: 30 },
      'hawk-eye': { name: 'Hawk Eye', desc: 'Catch the stowaway three crossings in a row.', icon: ICONS.star, xp: 80 },
      ghost: { name: 'Ghost Passenger', desc: 'Escape as the stowaway.', icon: ICONS.mask, xp: 60 },
      'mind-reader': { name: 'Mind Reader', desc: 'Get caught, then guess the real destination.', icon: ICONS.bulb, xp: 60 },
      'blend-in': { name: 'Blend In', desc: 'As the stowaway, light a lantern closer to the pack than any passenger.', icon: ICONS.copy, xp: 40 },
      'clean-ticket': { name: 'Clean Ticket', desc: 'Finish a crossing with zero votes against you.', icon: ICONS.ticket, xp: 25 },
      captain: { name: 'Captain', desc: 'Finish a voyage with the top score.', icon: ICONS.helm, xp: 100 },
      regular: { name: 'Regular Passenger', desc: 'Finish five voyages.', icon: ICONS.anchor, xp: 80 },
    },
  });
  const TAG_COLORS = ['#c9a24b', '#b5382f', '#5f8f8a', '#8a6d9c', '#d07a3a', '#4a7aa8', '#9aa04a', '#c06a86'];
  // Luggage-tag avatar, coloured from the player's id so it stays the same all game.
  function tagColor(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TAG_COLORS[h % TAG_COLORS.length]; }
  function avatar(id, size = '') {
    const name = player(id)?.name || '?';
    return `<span class="tagav ${size}" style="--c:${tagColor(id)}" aria-hidden="true">${esc(name[0].toUpperCase())}</span>`;
  }
  // How far one lantern sits from the middle of everyone else's on a chart.
  function driftOn(marks, id) {
    const mine = marks[id], rest = Object.entries(marks).filter(([k]) => k !== id).map(([, m]) => m);
    if (!mine || !rest.length) return null;
    return Math.hypot(mine.x - rest.reduce((n, m) => n + m.x, 0) / rest.length, mine.y - rest.reduce((n, m) => n + m.y, 0) / rest.length);
  }
  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  let processed = new Set(), voteStreak = 0, gameXP = 0;
  // Award XP and stamps for the round that just ended (personal progress only; the server keeps the real score).
  function processRound() {
    const d = state.round, me = state.me.id;
    const key = `${state.code}:${state.history.length}`;
    if (!d || d.voided || !d.order.includes(me) || processed.has(key) || !d.stowawayId) return;
    processed.add(key);
    let xp = 15;
    FX.bump('crossings');
    if (d.stowawayId !== me) {
      if (d.votes?.[me] === d.stowawayId) { xp += 25; voteStreak++; FX.bump('caught'); FX.unlock('first-catch'); if (voteStreak >= 3) FX.unlock('hawk-eye'); }
      else voteStreak = 0;
      if (!d.tally?.[me]) FX.unlock('clean-ticket');
    } else if (!d.caught) { xp += 60; FX.bump('escapes'); FX.unlock('ghost'); }
    else if (d.guessRight) { xp += 40; FX.unlock('mind-reader'); }
    if (d.stowawayId === me && (d.marks || []).some(m => { const mine = driftOn(m, me); return mine != null && Object.keys(m).filter(k => k !== me).every(k => driftOn(m, k) > mine); })) FX.unlock('blend-in');
    gameXP += xp;
    setTimeout(() => FX.addXP(xp, play.querySelector('.board li.mine') || play.querySelector('.phase-head')), 700);
  }
  function finishVoyage() {
    const key = `${state.code}:final:${state.history.length}:${state.history[0]?.groupWord}`;
    if (processed.has(key) || !state.history.length) return;
    processed.add(key);
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    const won = sorted[0]?.id === state.me.id && sorted[0].score > 0;
    FX.recordGame(won);
    gameXP += 30 + (won ? 80 : 0);
    setTimeout(() => {
      FX.addXP(30 + (won ? 80 : 0), play.querySelector('.podium .p1') || play);
      if (won) { FX.unlock('captain'); FX.burst(play.querySelector('.podium .p1'), { count: 40 }); }
      if (FX.profile().games >= 5) FX.unlock('regular');
      const box = play.querySelector('[data-r="voyage-xp"]'); if (box) box.textContent = `+${gameXP} XP this voyage`;
    }, 1600);
  }
  function shareText() {
    const sorted = [...state.players].sort((a, b) => b.score - a.score), me = player(state.me.id);
    const place = sorted.findIndex(p => p.id === state.me.id) + 1, caught = state.history.filter(h => h.caught).length;
    return `The Stowaway · night ferry ${state.code}\n${state.history.map(h => (h.caught ? '🟥' : '🟩')).join('')}  ${caught}/${state.history.length} stowaways caught\n${me?.name}: ${me?.score} pts, ${place} of ${sorted.length}\nPassenger rank: ${FX.level().name}`;
  }

  // ---------- Toasts and announcements ----------
  function toast(text, kind = '') {
    toastEl.textContent = text; toastEl.className = `toast show ${kind}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  function announce(text) { announcer.textContent = ''; setTimeout(() => { announcer.textContent = text; }, 30); }

  // ---------- Connection ----------
  function connect(hello) {
    clearTimeout(retryTimer);
    if (ws && ws.readyState <= 1) { ws.onclose = null; ws.close(); }
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
    ws.onopen = () => { retries = 0; document.body.classList.remove('offline'); ws.send(JSON.stringify(hello)); };
    ws.onmessage = event => { let m; try { m = JSON.parse(event.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      if (leaving) return;
      if (!state) { if (!silentJoin) showError('The ferry cannot be reached. Check your connection and try again.'); silentJoin = false; return; }
      document.body.classList.add('offline');
      const delay = Math.min(8000, 600 * 2 ** retries++);
      retryTimer = setTimeout(() => connect({ type: 'join', code: saved.code, token: saved.token, name: saved.name }), delay);
    };
  }
  function send(type, data = {}) {
    if (ws?.readyState === 1) { ws.send(JSON.stringify({ type, ...data })); return true; }
    toast('Still reconnecting. Hold tight.'); return false;
  }
  function onMessage(m) {
    if (m.type === 'joined') {
      Object.assign(saved, { code: m.code, token: m.token, id: m.id }); persist();
      silentJoin = false;
      const url = new URL(location.href); url.searchParams.set('ticket', m.code); history.replaceState(null, '', url);
    }
    if (m.type === 'state') {
      offset = m.state.serverNow - Date.now();
      const previous = state; state = m.state;
      render(previous);
    }
    if (m.type === 'reject') { toast(m.message, 'bad'); sound.play('reject'); buzz(80); shake(); }
    if (m.type === 'notice') toast(m.message);
    if (m.type === 'error') {
      if (m.code === 'no-room') {
        forget(); state = null; viewKey = null;
        showLanding();
        if (!silentJoin) showError(m.message);
        silentJoin = false;
        return;
      }
      if (m.code === 'replaced') { leaving = true; state = null; showLanding(); showError(m.message); return; }
      if (m.code === 'name-taken' && m.suggestion) $('#name').value = m.suggestion;
      if (!state) showError(m.message); else toast(m.message, 'bad');
    }
  }
  function shake() { const el = $('.entry input') || $('.entry'); if (!el) return; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }

  // ---------- Landing ----------
  const nameInput = $('#name'), codeInput = $('#code');
  nameInput.value = saved.name || '';
  const urlCode = (new URLSearchParams(location.search).get('ticket') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  codeInput.value = urlCode || '';
  $('#stub-no').textContent = 'Nº ' + String(Math.floor(Math.random() * 9000) + 1000);
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  function showError(text) { $('#error').textContent = text; }
  function readName() {
    const name = nameInput.value.trim();
    if (name.length < 2) { showError('Write a name of at least two letters on your ticket.'); nameInput.focus(); return null; }
    saved.name = name; persist(); showError(''); leaving = false; return name;
  }
  $('#board-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = readName(); if (!name) return;
    if (codeInput.value.length !== 4) { showError('Ticket numbers are four letters, like KFRT.'); codeInput.focus(); return; }
    const sameRoom = saved.code === codeInput.value;
    connect({ type: 'join', code: codeInput.value, name, token: sameRoom ? saved.token : undefined });
  });
  $('#host').addEventListener('click', () => { const name = readName(); if (name) { forget(); saved.name = name; persist(); connect({ type: 'create', name }); } });
  $('#practice').addEventListener('click', () => { const name = readName(); if (name) { forget(); saved.name = name; persist(); connect({ type: 'practice', name }); } });
  function showLanding() {
    FX.card($('#passport'));
    play.classList.add('hidden'); boarding.classList.remove('hidden'); document.body.dataset.phase = 'landing';
    const url = new URL(location.href); url.searchParams.delete('ticket'); history.replaceState(null, '', url);
    codeInput.value = '';
  }

  FX.card($('#passport'));

  // ---------- How to play carousel (PRD FE-8) ----------
  const how = $('#how'), slides = [...how.querySelectorAll('.slide')], dots = [...how.querySelectorAll('.dots i')];
  let slide = 0;
  function showSlide(i) {
    slide = i;
    slides.forEach((s, n) => s.classList.toggle('active', n === i)); dots.forEach((d, n) => d.classList.toggle('on', n === i));
    $('#how-step').textContent = `${i + 1} OF ${slides.length}`;
    $('#how-next').textContent = i === slides.length - 1 ? 'ALL ABOARD' : 'NEXT →';
  }
  function openHow() { showSlide(0); how.showModal(); }
  $('#help-open').addEventListener('click', openHow);
  $('#how-close').addEventListener('click', () => how.close());
  $('#how-skip').addEventListener('click', () => how.close());
  $('#how-next').addEventListener('click', () => slide < slides.length - 1 ? showSlide(slide + 1) : how.close());
  how.addEventListener('close', () => { try { localStorage.setItem('stowaway-help', '1'); } catch {} });
  if (!localStorage.getItem('stowaway-help')) setTimeout(openHow, 600);

  // ---------- Rendering ----------
  // Each screen has a shell (built once per key) and regions (patched in place), so inputs and animations survive updates.
  function render(previous) {
    boarding.classList.add('hidden'); play.classList.remove('hidden');
    document.body.dataset.phase = state.phase;
    const screen = SCREENS[state.phase]();
    const regions = { head: headRegion() + coachBar(), ...screen.regions };
    if (screen.key !== viewKey) {
      viewKey = screen.key;
      play.innerHTML = screen.shell;
      window.scrollTo(0, 0);
      screen.mount?.();
    }
    for (const [name, html] of Object.entries(regions)) {
      const el = play.querySelector(`[data-r="${name}"]`);
      if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; }
    }
    FX.paintChips();
    cues(previous);
    tick();
  }
  function cues(prev) {
    const p = state.phase, was = prev?.phase, d = state.round;
    if (!prev || p === was && !(p === 'chart' && prev.round?.chart !== d?.chart)) return;
    if (p === 'tickets') {
      sound.play('chime'); announce(`Round ${state.roundNumber}. Hold to read your ticket.`);
      if (state.roundNumber === 1) { gameXP = 0; voteStreak = 0; }
      FX.splash({ kicker: `NIGHT FERRY · ${state.pack.toUpperCase()}`, title: `CROSSING ${ROMAN[state.roundNumber] || state.roundNumber}`, sub: `${state.roundNumber} of ${state.totalRounds} · hold your ticket close`, ms: 1500 });
    }
    if (p === 'chart') { sound.play('turn'); buzz([60, 40, 60]); announce(`Chart ${d.chart + 1} of ${d.charts.length}: ${d.charts[d.chart].x.join(' to ')}, and ${d.charts[d.chart].y.join(' to ')}. Place your lantern.`); }
    if (p === 'lit') {
      sound.play('chime');
      announce(`Lanterns lit on chart ${d.chart + 1}.`);
      play.querySelectorAll('.lamp').forEach(l => l.addEventListener('animationstart', () => sound.play('pop'), { once: true }));
    }
    if (p === 'discuss') { sound.play('chime'); announce('Both charts are lit. Discuss whose lanterns drifted.'); }
    if (p === 'vote') { sound.play('chime'); announce('Voting is open. Who is the stowaway?'); FX.splash({ kicker: 'ALL PASSENGERS', title: 'CAST YOUR VOTE', sub: 'Who doesn\u2019t belong aboard?', ms: 1100 }); }
    if (p === 'reveal') {
      sound.play('horn'); setTimeout(() => { sound.play('stamp'); buzz(120); }, 900);
      // Among Us-style reveal: dark beat, stamp slam, then the verdict types out.
      const h = play.querySelector('.reveal-name'), text = h?.textContent || '';
      if (h) { h.textContent = ''; setTimeout(() => FX.typewriter(h, text, 32), 1350); }
      setTimeout(() => { FX.shake(play.querySelector('.stage'), 1.4); if (d.caught) FX.burst(play.querySelector('.stamp'), { count: 30 }); }, 1150);
      play.querySelectorAll('.vchip').forEach(v => v.addEventListener('animationstart', () => sound.play('pop'), { once: true }));
    }
    if (p === 'scores' && !d?.voided) {
      processRound();
      play.querySelectorAll('.b-score[data-from]').forEach(n => FX.countUp(n, Number(n.textContent), { from: Number(n.dataset.from), ms: 1100 }));
      if (d && d.stowawayId !== state.me.id && d.votes?.[state.me.id] === d.stowawayId) FX.burst(play.querySelector('.board li.mine'), { count: 18 });
    }
    if (p === 'guess' && d.stowawayId === state.me.id) { sound.play('turn'); announce('You were caught. Make one final guess.'); }
    if (p === 'final') { sound.play('win'); processRound(); finishVoyage(); setTimeout(() => FX.burst(play.querySelector('.podium'), { count: 36, spread: 1.3 }), 500); }
  }

  const SCREENS = {
    lobby() {
      return {
        key: 'lobby',
        shell: `<div data-r="head"></div>
          <section class="manifest card-cream">
            <div class="manifest-top"><div><div class="label">PASSENGER MANIFEST</div><h2>ALL ABOARD</h2></div><div data-r="count"></div></div>
            <div data-r="berths" class="berths"></div>
            <div data-r="settings"></div>
            <div data-r="start"></div>
          </section>`,
        regions: { count: lobbyCount(), berths: berths(), settings: lobbySettings(), start: lobbyStart() },
      };
    },
    tickets() {
      const t = state.me.ticket;
      return {
        key: `tickets:${state.roundNumber}:${!!t}`,
        shell: `<div data-r="head"></div>
          <section class="stage">
            ${phaseTitle('BOARDING', 'YOUR DESTINATION', 'Keep it secret. Soon you\u2019ll place lanterns on the night chart to show where it belongs.')}
            ${t ? ticketCard(t) : '<div class="ticket-card spectating"><div class="ticket-label">NO TICKET THIS ROUND</div><p>You boarded mid-crossing. Watch closely; you sail next round.</p></div>'}
          </section>`,
        regions: {},
        mount: wireHold,
      };
    },
    chart() {
      const d = state.round, i = d.chart, placed = !!d.marks[i]?.[state.me.id], inRound = me()?.inRound && !me()?.spectator;
      return {
        key: `chart:${state.roundNumber}:${i}:${placed}`,
        shell: `<div data-r="head"></div>
          <section class="stage">
            ${phaseTitle(`CHART ${i + 1} OF ${d.charts.length}`, placed ? 'YOUR LANTERN IS LIT' : 'PLACE YOUR LANTERN', placed ? 'Waiting for the other passengers. Every lantern lights at once.' : 'Where does <em>your</em> destination sit on these two scales? Tap the chart, then light your lantern.')}
            <div data-r="chart"></div>
            <div data-r="action" class="place-row"></div>
            ${i > 0 ? '<div data-r="earlier" class="chart-earlier"></div>' : ''}
            ${peek()}
          </section>`,
        regions: { chart: chartHtml(i, { placing: inRound && !placed }), action: placeRow(), earlier: i > 0 ? `<div class="label">EARLIER, ON CHART ${i}</div>${chartHtml(i - 1, { small: true })}` : '' },
        mount: wireHold,
      };
    },
    lit() {
      const d = state.round, i = d.chart;
      return {
        key: `lit:${state.roundNumber}:${i}`,
        shell: `<div data-r="head"></div>
          <section class="stage">
            ${phaseTitle(`CHART ${i + 1} OF ${d.charts.length}`, 'LANTERNS LIT', 'Whose lantern sits apart from the rest? It might be the stowaway, or it might be you.')}
            <div data-r="chart"></div>
            ${peek()}
          </section>`,
        regions: { chart: chartHtml(i, { reveal: true }) },
        mount: wireHold,
      };
    },
    discuss() {
      return {
        key: `discuss:${state.roundNumber}`,
        shell: `<div data-r="head"></div>
          <section class="stage">
            ${phaseTitle('DISCUSS', 'READ THE CHARTS', 'Talk it over out loud or on your call. Tap a passenger to pin your suspicion; their lanterns glow.')}
            <div data-r="charts" class="chart-pair"></div>
            <div data-r="cards" class="suspect-grid"></div>
            <div data-r="lantern" class="lantern-panel"></div>
            <div data-r="ready" class="ready-row"></div>
            ${peek()}
          </section>`,
        regions: { charts: bothCharts(state.round.suspicions[state.me.id]), cards: suspectCards(), lantern: lanternPanel(), ready: readyRow() },
        mount: wireHold,
      };
    },
    vote() {
      return {
        key: `vote:${state.roundNumber}`,
        shell: `<div data-r="head"></div>
          <section class="stage">
            ${phaseTitle('VOTE', 'WHO IS THE STOWAWAY?', 'Pick the passenger whose lanterns drifted from the pack. You can change your vote until the bell.')}
            <div data-r="cards" class="vote-grid"></div>
            <div data-r="status" class="status-line"></div>
            <div data-r="charts" class="chart-pair"></div>
            ${peek()}
          </section>`,
        regions: { charts: bothCharts(state.round.myVote), cards: voteCards(), status: voteStatus() },
        mount: wireHold,
      };
    },
    reveal() {
      return { key: `reveal:${state.roundNumber}`, shell: `<div data-r="head"></div><section class="stage" data-r="body"></section>`, regions: { body: revealBody() } };
    },
    guess() {
      const mine = state.round.stowawayId === state.me.id;
      return {
        key: `guess:${state.roundNumber}:${mine}`,
        shell: `<div data-r="head"></div>
          <section class="stage">
            ${phaseTitle('LAST CHANCE', mine ? 'ONE LAST GUESS' : 'THE STOWAWAY GUESSES', mine ? 'You were found out. Name the passengers’ destination for +100.' : `${esc(nameOf(state.round.stowawayId))} has one guess at the real destination.`)}
            ${mine ? `<div class="their-ticket">YOUR TICKET SAID <b>${esc(state.round.stowawayWord)}</b></div>
              <p class="lede">Read the passengers' lanterns: where did they put their destination?</p>
              <div class="chart-pair">${bothCharts(null, { except: state.me.id })}</div>
              <form class="entry" id="guess-form"><label class="sr-only" for="guess-input">Your final guess</label><input id="guess-input" maxlength="40" placeholder="The real destination" autocomplete="off" spellcheck="false" enterkeyhint="send"><button class="btn brass">FINAL GUESS <span>→</span></button></form>`
              : `<div class="guess-wait"><div class="stamp-small">CAUGHT</div><p>They are reading the charts for clues.</p><div class="chart-pair">${bothCharts(state.round.stowawayId)}</div></div>`}
          </section>`,
        regions: {},
        mount() {
          const form = $('#guess-form'); if (!form) return;
          $('#guess-input').focus({ preventScroll: true });
          form.addEventListener('submit', e => { e.preventDefault(); const w = $('#guess-input').value.trim(); if (!w) return shake(); send('guess', { word: w }); });
        },
      };
    },
    scores() {
      return { key: `scores:${state.roundNumber}:${state.round?.voided ? 'void' : ''}`, shell: `<div data-r="head"></div><section class="stage" data-r="body"></section>`, regions: { body: scoresBody() } };
    },
    final() {
      return { key: 'final', shell: `<div data-r="head"></div><section class="stage" data-r="body"></section>`, regions: { body: finalBody() } };
    },
  };

  // ---------- Shared pieces ----------
  function coachBar() {
    const c = coach(); if (!c) return '';
    return `<div class="coach" role="note"><span class="coach-tag">YOUR MOVE</span><div class="coach-text"><b>${c[0]}</b>${c[1] ? `<span>${c[1]}</span>` : ''}</div></div>`;
  }
  // Plain-language instruction for exactly what this player should do right now.
  function coach() {
    const p = state.phase, d = state.round, meP = me(), host = isHost();
    if (meP?.spectator && p !== 'lobby' && p !== 'final') return ['You\u2019re watching this crossing.', 'You\u2019ll get your own ticket when the next crossing starts.'];
    if (p === 'lobby') {
      const n = state.players.filter(x => x.connected).length;
      return host ? (n < 3 ? ['Get at least 3 passengers aboard.', 'Share the ticket code, or tap + ADD A BOT to fill seats. Then press START CROSSING.'] : ['Press START CROSSING when everyone is aboard.', 'Each player needs their own phone or laptop. Keep your screen private.'])
        : ['Wait for the purser to start.', 'Keep your screen private. You\u2019ll get a secret word.'];
    }
    if (p === 'tickets') return ['Press and hold your ticket to see your secret word.', 'Everyone has the same word except one passenger, the stowaway, who has a similar word. It might be you, and nobody is told.'];
    if (p === 'chart') {
      const c = d.charts[d.chart];
      return d.marks[d.chart]?.[state.me.id] ? ['Your lantern is lit. Wait for the others.', 'All lanterns appear at the same moment, so nobody can copy.']
        : [`Tap where your word belongs: ${c.x[0]} \u2194 ${c.x[1]} across, ${c.y[0]} \u2194 ${c.y[1]} up.`, 'Then press LIGHT MY LANTERN. There\u2019s no right answer; the stowaway\u2019s word is similar but not the same, so their lantern tends to drift.'];
    }
    if (p === 'lit') return d.chart + 1 < d.charts.length ? ['Look for a lantern away from the pack.', 'A second chart comes next. If yours was the odd one out, you might be the stowaway: blend in on the next chart.'] : ['Both charts are lit.', 'Discussion opens next. Whose lanterns drifted twice?'];
    if (p === 'discuss') return ['Talk it over, then press READY TO VOTE.', 'Tap a passenger to mark who you suspect. You can also shine your lantern once per voyage to secretly test one passenger.'];
    if (p === 'vote') return ['Tap the passenger you think has the different word.', 'Most votes is put ashore. A tie lets the stowaway escape. You can change your vote until time runs out.'];
    if (p === 'reveal') return ['Here\u2019s who was put ashore.', d?.caught ? 'They were the stowaway. They now get one guess at the real word.' : 'The stowaway escaped this time.'];
    if (p === 'guess') return d.stowawayId === state.me.id ? ['You were caught! Guess everyone else\u2019s word.', 'Their lanterns show where it sits on each scale. A right guess still earns you +100.'] : ['The stowaway is guessing your word.', 'Wait a moment. Your lanterns might give it away.'];
    if (p === 'scores') return ['Points from this crossing.', '+100 for each correct vote, +200 if the stowaway escapes, +100 for a right last guess. The next crossing starts by itself.'];
    if (p === 'final') return ['Voyage over. Highest score wins.', host ? 'Press SAIL AGAIN to play another voyage with the same group.' : 'Wait for the purser to sail again, or share your result.'];
    return null;
  }
  function headRegion() {
    const live = state.phase !== 'lobby' && state.phase !== 'final';
    const spectator = me()?.spectator && live;
    return `<div class="shiphead">
      <div class="shiphead-code"><span class="label">TICKET</span><span class="flap">${[...state.code].map(c => `<b>${c}</b>`).join('')}</span>
        <button class="link-btn" data-action="invite">INVITE</button></div>
      <div class="shiphead-mid">${live ? `<span class="label">CROSSING</span><b>${state.roundNumber} <i>OF</i> ${state.totalRounds}</b>` : ''}</div>
      <div class="shiphead-right">${voteStreak >= 2 ? `<span class="streak hot" title="Correct votes in a row">SHARP EYE <b>×${voteStreak}</b></span>` : ''}${isHost() ? '<span class="purser">✦ PURSER</span>' : ''}<button class="link-btn" data-action="leave">LEAVE</button></div>
    </div>
    ${spectator ? '<div class="banner">You boarded mid-crossing. Watch this round; you get a ticket next round.</div>' : ''}
    ${state.paused ? `<div class="banner warn">Fewer than three passengers aboard. The crossing is paused while they reconnect.${isHost() ? ' <button class="link-btn" data-action="skip">RETURN TO PORT</button>' : ''}</div>` : ''}`;
  }
  function phaseTitle(label, title, lede) {
    return `<div class="phase-head">
      <div class="phase-copy"><div class="label">${label}</div><h2>${title}</h2><p class="lede">${lede}</p></div>
      ${porthole()}
    </div>`;
  }
  function porthole() {
    return `<div class="porthole" data-clock aria-hidden="true"><svg viewBox="0 0 100 100"><circle class="rim" cx="50" cy="50" r="44"/><circle class="ring" cx="50" cy="50" r="44" pathLength="100"/>${Array.from({ length: 8 }, (_, i) => `<circle class="bolt" cx="${50 + 49 * Math.cos(i * Math.PI / 4)}" cy="${50 + 49 * Math.sin(i * Math.PI / 4)}" r="1.8"/>`).join('')}</svg><b data-secs>--</b></div>`;
  }
  function ticketCard(word) {
    return `<div class="ticket-card">
      <div class="ticket-perf" aria-hidden="true"></div>
      <div class="ticket-label">NIGHT FERRY · PASSENGER TICKET · ROUND ${state.roundNumber}</div>
      <div class="ticket-dest">DESTINATION</div>
      <div class="ticket-word" data-secret="${esc(word.toUpperCase())}" aria-live="polite">● ● ● ● ● ●</div>
      <button class="hold" type="button" data-hold>HOLD TO REVEAL</button>
      <div class="ticket-foot"><span>ADMIT ONE</span><span>Nº ${state.code}-${pad(state.roundNumber)}</span></div>
    </div>`;
  }
  function peek() {
    return state.me.ticket ? `<div class="peek"><button class="peek-btn" type="button" data-hold>HOLD TO PEEK AT YOUR TICKET</button><span class="ticket-word mini" data-secret="${esc(state.me.ticket.toUpperCase())}">● ● ● ●</span></div>` : '';
  }
  // Hold-to-reveal so nobody reads a ticket over a shoulder (PRD FE-3).
  function wireHold() {
    for (const btn of play.querySelectorAll('[data-hold]')) {
      const word = btn.parentElement.querySelector('[data-secret]');
      const masked = word.textContent;
      const show = e => { e.preventDefault(); word.textContent = word.dataset.secret; word.classList.add('shown'); btn.classList.add('held'); };
      const hide = () => { word.textContent = masked; word.classList.remove('shown'); btn.classList.remove('held'); };
      btn.addEventListener('pointerdown', show); btn.addEventListener('pointerup', hide); btn.addEventListener('pointerleave', hide); btn.addEventListener('pointercancel', hide);
      btn.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') show(e); });
      btn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') hide(); });
      btn.addEventListener('blur', hide); btn.addEventListener('contextmenu', e => e.preventDefault());
    }
  }

  // ---------- Lobby ----------
  function lobbyCount() {
    const n = state.players.length;
    return `<div class="count-badge"><b>${n}</b><span>OF 8</span></div>`;
  }
  function berths() {
    const rows = state.players.map((p, i) => `<li class="berth ${p.connected ? '' : 'away'}">
        <span class="berth-no">${pad(i + 1)}</span>
        ${avatar(p.id)}<span class="berth-name">${esc(p.name)}</span>
        <span class="tags">${p.id === state.hostId ? '<i class="tag brass">PURSER</i>' : ''}${p.id === state.me.id ? '<i class="tag">YOU</i>' : ''}${p.isBot ? '<i class="tag ghost">BOT</i>' : ''}${!p.connected ? '<i class="tag ghost">AWAY</i>' : ''}</span>
        ${isHost() && p.isBot ? `<button class="x-btn" data-action="removeBot" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>` : ''}
      </li>`);
    for (let i = state.players.length; i < 8; i++) rows.push(`<li class="berth empty"><span class="berth-no">${pad(i + 1)}</span><span class="berth-name">— empty berth —</span></li>`);
    return `<ol>${rows.join('')}</ol>`;
  }
  function lobbySettings() {
    const host = isHost();
    const seg = (action, value, options, label) => `<div class="setting"><div class="label">${label}</div><div class="seg" role="group" aria-label="${label}">${options.map(o => `<button type="button" ${host ? '' : 'disabled'} class="${String(o.value) === String(value) ? 'on' : ''}" data-action="${action}" data-value="${esc(o.value)}" aria-pressed="${String(o.value) === String(value)}">${esc(o.label)}</button>`).join('')}</div></div>`;
    return `<div class="settings">
      ${seg('pack', state.pack, state.packs.map(p => ({ value: p, label: p === 'Everyday Objects' ? 'Objects' : p })), 'WORD PACK')}
      ${seg('rounds', state.totalRounds, [3, 5, 7].map(n => ({ value: n, label: `${n} rounds` })), 'CROSSING LENGTH')}
    </div>`;
  }
  function lobbyStart() {
    const ready = state.players.filter(p => p.connected).length;
    if (!isHost()) return `<p class="waiting-note">Waiting for the purser to start the crossing. ${ready < 3 ? 'Three passengers are needed to sail.' : ''}</p>`;
    return `<div class="start-row">
      <button class="btn outline" data-action="addBot" ${state.players.length >= 8 ? 'disabled' : ''}>+ ADD A BOT</button>
      <button class="btn brass" data-action="start" ${ready < 3 ? 'disabled' : ''}>START CROSSING <span>→</span></button>
    </div>
    <p class="waiting-note">${ready < 3 ? `Needs ${3 - ready} more passenger${3 - ready === 1 ? '' : 's'}. Share the ticket number or add a bot.` : 'Everyone keeps their phone private. Talk out loud or on your call.'}</p>`;
  }

  // ---------- The Night Chart ----------
  // Lantern positions run 0-100 on each axis: x from the first label to the second, y from the bottom label up to the top one.
  let pending = null, pendingKey = '';
  function chartHtml(i, { placing = false, small = false, reveal = false, highlight = null, except = null } = {}) {
    const d = state.round, c = d.charts[i], marks = d.marks[i] || {};
    // A new chart starts with no lantern in hand.
    if (placing && pendingKey !== `${state.roundNumber}:${i}`) { pendingKey = `${state.roundNumber}:${i}`; pending = null; }
    // Names sit below each lantern, flipping above when they would hit the bottom edge or a neighbour's name.
    const shown = Object.entries(marks).filter(([id]) => id !== except), below = [];
    // A name hangs in the strip just under its lantern; it is blocked by a lantern or another name in that strip.
    const blocked = (m, dir) => shown.some(([, o]) => o !== m && Math.abs(o.x - m.x) < 14 && (o.y - m.y) * dir > 0 && Math.abs(o.y - m.y) < 13)
      || (dir < 0 && below.some(o => Math.abs(o.x - m.x) < 22 && Math.abs(o.y - m.y) < 12));
    const lamps = shown.map(([id, m], n) => {
      const up = m.y < 12 || (blocked(m, -1) && !blocked(m, 1) && m.y < 88);
      if (!up) below.push(m);
      return `<span class="lamp ${up ? 'up' : ''} ${m.x > 85 ? 'edge-r' : m.x < 15 ? 'edge-l' : ''} ${id === state.me.id ? 'mine' : ''} ${highlight === id ? 'hl' : ''} ${reveal ? 'drop' : ''}" style="left:${m.x}%;top:${100 - m.y}%;--c:${tagColor(id)};--d:${(0.3 + n * 0.28).toFixed(2)}s"><i aria-hidden="true"></i><b>${esc(nameOf(id))}${id === state.me.id ? ' (you)' : ''}</b></span>`;
    }).join('');
    const ghost = placing && pending ? `<span class="lamp ghost" style="left:${pending.x}%;top:${100 - pending.y}%;--c:${tagColor(state.me.id)}"><i aria-hidden="true"></i><b>your lantern</b></span>` : '';
    const listed = Object.entries(marks).filter(([id]) => id !== except).map(([id, m]) => `${nameOf(id)}: ${m.x} toward ${c.x[1]}, ${m.y} toward ${c.y[1]}`).join('; ');
    return `<figure class="chart ${small ? 'small' : ''}">
      <div class="ax ax-top">↑ ${esc(c.y[1])}</div>
      <div class="chart-field ${placing ? 'placing' : ''}" data-chart-field ${placing ? `tabindex="0" role="application" aria-label="Chart ${i + 1}. Across: ${esc(c.x[0])} to ${esc(c.x[1])}. Up: ${esc(c.y[0])} to ${esc(c.y[1])}. Tap or use the arrow keys to place your lantern, then Enter to light it."` : `role="img" aria-label="Chart ${i + 1}. ${esc(listed || 'No lanterns yet.')}"`}>${lamps}${ghost}${placing && !pending ? '<span class="tap-hint">TAP TO PLACE</span>' : ''}</div>
      <div class="ax-row"><span>← ${esc(c.x[0])}</span><span class="ax-low">↓ ${esc(c.y[0])}</span><span>${esc(c.x[1])} →</span></div>
    </figure>`;
  }
  function bothCharts(highlight, opts = {}) {
    const d = state.round;
    return d.charts.map((_, i) => `<div><div class="label">CHART ${i + 1}</div>${chartHtml(i, { small: true, highlight, ...opts })}</div>`).join('');
  }
  function placeRow() {
    const d = state.round, crew = state.players.filter(p => p.inRound && p.connected && !p.spectator);
    const n = crew.filter(p => d.placed.includes(p.id)).length, mine = d.marks[d.chart]?.[state.me.id];
    const status = `<span class="ready-count">${n} of ${crew.length} lanterns lit${n === crew.length ? ' · lighting the chart' : ''}</span>`;
    if (!me()?.inRound || me()?.spectator) return status;
    return `${mine ? '<span class="lit-note">✦ Lit. Nobody sees it until every lantern is in.</span>' : `<button class="btn brass" data-action="place" ${pending ? '' : 'disabled'}>LIGHT MY LANTERN <span>→</span></button>`}${status}`;
  }
  function setPending(x, y) {
    pending = { x: Math.max(0, Math.min(100, Math.round(x))), y: Math.max(0, Math.min(100, Math.round(y))) };
    render(state);
  }

  // ---------- Discuss ----------
  function suspectCards() {
    const d = state.round, pins = {};
    for (const [who, target] of Object.entries(d.suspicions)) (pins[target] ||= []).push(who);
    const mine = d.suspicions[state.me.id];
    const canPin = me()?.inRound && !me()?.spectator;
    return d.order.map((id, i) => {
      const list = pins[id] || [];
      const self = id === state.me.id;
      return `<button type="button" class="suspect ${mine === id ? 'pinned' : ''}" data-action="suspect" data-id="${id}" ${self || !canPin ? 'disabled' : ''} aria-pressed="${mine === id}">
        <span class="suspect-no">${pad(i + 1)}</span>
        <span class="suspect-name">${avatar(id, 'sm')}${esc(nameOf(id))}${self ? ' · YOU' : ''}</span>
        ${(d.lanterns || []).some(l => l.target === id) ? `<span class="lit">LANTERN · ${(d.lanterns || []).filter(l => l.target === id).map(l => esc(nameOf(l.by))).join(', ')}</span>` : ''}
        <span class="pins">${list.length ? `${'<i class="pin"></i>'.repeat(list.length)} <small>${list.map(w => esc(nameOf(w))).join(', ')}</small>` : '<small class="muted">no suspicion</small>'}</span>
      </button>`;
    }).join('');
  }
  // The Purser's Lantern: a once-per-voyage private check. "Different" means one of you is the stowaway.
  function lanternPanel() {
    const d = state.round, mine = state.me, log = mine.lanterns || [];
    const results = log.map(l => `<li class="${l.same ? 'same' : 'diff'}"><b>Crossing ${l.round}:</b> ${esc(nameOf(l.target))} holds ${l.same ? 'the <em>same</em> destination as you.' : 'a <em>different</em> destination. One of you is the stowaway.'}</li>`).join('');
    const canUse = !mine.lanternUsed && me()?.inRound && !me()?.spectator;
    return `<div class="lantern-head"><span class="lantern-icon" aria-hidden="true"></span><div><b>THE PURSER'S LANTERN</b><small>${mine.lanternUsed ? 'Spent for this voyage.' : 'One use per voyage. Learn privately whether one passenger\u2019s ticket matches yours. Everyone sees whom you checked, not what you learned.'}</small></div></div>
      ${canUse ? `<div class="lantern-targets">${d.order.filter(id => id !== mine.id).map(id => `<button type="button" class="lantern-btn" data-action="lantern" data-id="${id}">${avatar(id, 'sm')}Shine on ${esc(nameOf(id))}</button>`).join('')}</div>` : ''}
      ${results ? `<ul class="lantern-log">${results}</ul>` : ''}`;
  }
  function readyRow() {
    const d = state.round, crew = state.players.filter(p => p.inRound && p.connected && !p.spectator);
    const n = crew.filter(p => d.ready.includes(p.id)).length, mineReady = d.ready.includes(state.me.id);
    return `${me()?.inRound ? `<button class="btn ${mineReady ? 'dark' : 'brass'}" data-action="ready">${mineReady ? 'WAIT, KEEP TALKING' : 'READY TO VOTE'}</button>` : ''}
      <span class="ready-count">${n} of ${crew.length} ready · voting opens early when everyone is</span>`;
  }

  // ---------- Vote ----------
  function voteCards() {
    const d = state.round, canVote = me()?.inRound && !me()?.spectator;
    return d.order.filter(id => id !== state.me.id).map(id => {
      const chosen = d.myVote === id;
      return `<button type="button" class="vote-card ${chosen ? 'chosen' : ''}" data-action="vote" data-id="${id}" ${canVote ? '' : 'disabled'} aria-pressed="${chosen}">
        <span class="vc-name">${avatar(id)}${esc(nameOf(id))}</span>
        <span class="vc-mark">${chosen ? 'YOUR VOTE' : d.voted.includes(id) ? 'HAS VOTED' : ''}</span>
      </button>`;
    }).join('');
  }
  function voteStatus() {
    const d = state.round, crew = state.players.filter(p => p.inRound && p.connected && !p.spectator);
    const n = crew.filter(p => d.voted.includes(p.id)).length;
    const all = n === crew.length;
    const lit = (state.me.lanterns || []).filter(l => l.round === state.roundNumber).map(l => `<span class="lantern-note ${l.same ? 'same' : 'diff'}">Lantern: ${esc(nameOf(l.target))} ${l.same ? 'matches you' : 'does not match you'}</span>`).join('');
    return `${lit}${d.myVote ? `Your vote: <b>${esc(nameOf(d.myVote))}</b>. Change it any time before the bell.` : me()?.inRound ? 'Tap a passenger to cast your vote.' : 'Passengers are voting.'}
      <span class="vote-meter"><span style="width:${crew.length ? n / crew.length * 100 : 0}%"></span></span><small>${n} of ${crew.length} votes in${all ? ' · docking now' : ''}</small>`;
  }

  // ---------- Reveal and scores ----------
  function revealBody() {
    const d = state.round, stow = nameOf(d.stowawayId), accused = d.accusedId && nameOf(d.accusedId);
    const stamp = d.caught ? ['STOWAWAY CAUGHT', 'red'] : d.accusedId ? ['WRONG PASSENGER', 'brass'] : ['NO MAJORITY', 'brass'];
    const mine = d.stowawayId === state.me.id;
    const headline = d.caught ? (mine ? 'You were the stowaway, and they caught you.' : `${esc(stow)} was the stowaway.`) : mine ? `You were the stowaway${d.accusedId ? `, and ${esc(accused)} took the blame` : ''}. You slipped through.` : d.accusedId ? `${esc(accused)} was innocent. The stowaway was ${esc(stow)}.` : `The vote was split. ${esc(stow)} slipped through.`;
    const max = Math.max(1, ...Object.values(d.tally || {}));
    const voters = {};
    for (const [v, t] of Object.entries(d.votes || {})) (voters[t] ||= []).push(v);
    const rows = d.order.map(id => ({ id, n: d.tally?.[id] || 0 })).sort((a, b) => b.n - a.n);
    return `<div class="reveal">
      <div class="stamp ${stamp[1]}">${stamp[0]}</div>
      <h2 class="reveal-name">${headline}</h2>
      <div class="ticket-pair">
        <div class="stub odd"><small>${esc(stow)}'S TICKET</small><b>${esc(d.stowawayWord)}</b></div>
        <div class="stub ${d.groupWord ? '' : 'sealed'}"><small>EVERYONE ELSE</small><b>${d.groupWord ? esc(d.groupWord) : 'SEALED'}</b></div>
      </div>
      ${d.caught ? `<p class="lede center">${esc(stow)} gets one last guess at the real destination…</p>` : `<p class="lede center">${esc(stow)} escapes with +200.</p>`}
      <h3 class="label">THE STOWAWAY'S LANTERNS</h3>
      <div class="chart-pair">${bothCharts(d.stowawayId)}</div>
      <h3 class="label">THE VOTE</h3>
      <ul class="tally">${rows.map(r => `<li class="${r.id === d.stowawayId ? 'is-stow' : ''}"><span class="t-name">${avatar(r.id, 'sm')}${esc(nameOf(r.id))}${r.id === d.stowawayId ? ' <i class="tag red">STOWAWAY</i>' : ''}</span><span class="t-bar"><span style="width:${r.n / max * 100}%"></span></span><span class="t-n">${r.n}</span><span class="t-who">${(voters[r.id] || []).map((v, i) => `<span class="vchip" style="--d:${(1.9 + i * 0.22).toFixed(2)}s" title="${esc(nameOf(v))}">${avatar(v, 'sm')}<span class="sr-only">${esc(nameOf(v))}</span></span>`).join('')}</span></li>`).join('')}</ul>
    </div>`;
  }
  function scoresBody() {
    const d = state.round;
    if (d?.voided) return `${phaseTitle('CROSSING VOIDED', 'MAN OVERBOARD', esc(d.voided))}<p class="waiting-note center">A fresh crossing begins shortly. No points were scored.</p>`;
    const stow = nameOf(d.stowawayId);
    const sorted = [...state.players].filter(p => p.inRound || p.score).sort((a, b) => b.score - a.score);
    const outcome = d.caught ? (d.guessRight ? `${esc(stow)} was caught but guessed it: <b>“${esc(d.guess)}”</b>.` : `${esc(stow)} was caught${d.guess ? ` and guessed <b>“${esc(d.guess)}”</b>` : ' and made no guess'}.`) : `${esc(stow)} slipped through.`;
    return `${phaseTitle(`CROSSING ${state.roundNumber} OF ${state.totalRounds}`, 'PASSENGERS, TAKE NOTE', outcome)}
      <div class="ticket-pair">
        <div class="stub odd"><small>STOWAWAY · ${esc(stow)}</small><b>${esc(d.stowawayWord)}</b></div>
        <div class="stub"><small>PASSENGERS</small><b>${esc(d.groupWord)}</b></div>
      </div>
      ${board(sorted, d.deltas)}
      <p class="waiting-note center">Next crossing boards when the timer runs out.</p>`;
  }
  function board(list, deltas = {}) {
    // Rank arrows compare with the order before this round's points (Jackbox-style leaderboard shuffle).
    const before = [...list].sort((a, b) => (b.score - (deltas[b.id] || 0)) - (a.score - (deltas[a.id] || 0))).map(p => p.id);
    return `<ol class="board">${list.map((p, i) => {
      const moved = before.indexOf(p.id) - i;
      return `<li class="${p.id === state.me.id ? 'mine' : ''}" style="--i:${i}"><span class="rank">${i + 1}</span><span class="b-name">${avatar(p.id, 'sm')}${esc(p.name)}${p.isBot ? ' <i class="tag ghost">BOT</i>' : ''}${moved > 0 ? `<i class="move up">▲${moved}</i>` : moved < 0 ? `<i class="move down">▼${-moved}</i>` : ''}</span>${deltas[p.id] ? `<span class="delta">+${deltas[p.id]}</span>` : '<span></span>'}<b class="b-score" ${deltas[p.id] ? `data-from="${p.score - deltas[p.id]}"` : ''}>${p.score}</b></li>`;
    }).join('')}</ol>`;
  }
  function podium(sorted) {
    const top = sorted.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    return `<div class="podium">${order.map(p => { const place = sorted.indexOf(p) + 1; return `<div class="pod p${place}">${avatar(p.id, 'lg')}<b>${esc(p.name)}</b><span>${p.score} pts</span><div class="block">${['', 'I', 'II', 'III'][place]}</div></div>`; }).join('')}</div>`;
  }
  function finalBody() {
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    const top = sorted[0], tie = sorted[1] && sorted[1].score === top?.score;
    const caught = state.history.filter(h => h.caught).length;
    return `<div class="final">
      <div class="stamp brass">FERRY DOCKED</div>
      <h2 class="reveal-name">${top ? (tie ? 'A shared captaincy.' : `${esc(top.name)} reads people best.`) : 'The crossing is over.'}</h2>
      <p class="lede center">${plural(state.history.length, 'crossing')} · ${caught} stowaway${caught === 1 ? '' : 's'} caught · ${state.history.length - caught} escaped</p>
      ${podium(sorted)}
      ${board(sorted)}
      <div class="voyage-card"><div><div class="label">YOUR VOYAGE</div><b data-r="voyage-xp">Tallying your stamps…</b></div><span data-fx-chip></span><button class="btn outline" data-action="share">SHARE RESULT</button></div>
      <h3 class="label">VOYAGE LOG</h3>
      <div class="log-wrap"><table class="log"><thead><tr><th>#</th><th>Stowaway</th><th>Tickets</th><th>Outcome</th></tr></thead><tbody>
        ${state.history.map(h => `<tr><td>${h.number}</td><td>${esc(h.stowaway)}</td><td><b>${esc(h.groupWord)}</b> / <span class="red-text">${esc(h.stowawayWord)}</span></td><td>${h.caught ? (h.guessRight ? 'Caught · guessed it' : 'Caught') : 'Escaped'}</td></tr>`).join('')}
      </tbody></table></div>
      ${isHost() ? '<button class="btn brass wide" data-action="again">SAIL AGAIN <span>↻</span></button>' : '<p class="waiting-note center">Waiting for the purser to sail again.</p>'}
    </div>`;
  }

  // ---------- Clock ----------
  function tick() {
    if (!state) return;
    const clock = play.querySelector('[data-clock]');
    if (!clock || !state.endsAt) return;
    const at = state.paused ? state.paused.since : now();
    const left = Math.max(0, state.endsAt - at), secs = Math.ceil(left / 1000);
    clock.querySelector('[data-secs]').textContent = secs;
    clock.style.setProperty('--frac', state.phaseMs ? Math.min(1, left / state.phaseMs) : 0);
    clock.classList.toggle('low', secs <= 5 && !state.paused);
    if (secs !== lastSecond) {
      lastSecond = secs;
      const urgent = (state.phase === 'chart' && !state.round.marks[state.round.chart]?.[state.me.id]) || state.phase === 'vote' || (state.phase === 'guess' && state.round.stowawayId === state.me.id);
      if (urgent && secs <= 5 && secs > 0 && !state.paused) sound.play('tick');
      if (secs > 0 && secs % 10 === 0) announce(`${secs} seconds remaining`);
    }
  }
  setInterval(tick, 250);

  // ---------- Actions ----------
  play.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    if (a === 'invite') {
      const link = `${location.origin}/?ticket=${state.code}`;
      if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({ title: 'The Stowaway', text: `Board my ferry with ticket ${state.code}`, url: link }); } catch {} return; }
      try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); } catch { toast(`Share this link: ${link}`); }
      return;
    }
    if (a === 'leave') { leaving = true; send('leave'); ws?.close(); forget(); state = null; viewKey = null; showLanding(); return; }
    if (a === 'pack') send('pack', { pack: el.dataset.value });
    if (a === 'rounds') send('rounds', { rounds: Number(el.dataset.value) });
    if (a === 'addBot') send('addBot');
    if (a === 'removeBot') send('removeBot', { id: el.dataset.id });
    if (a === 'start') send('start');
    if (a === 'suspect') { send('suspect', { target: el.dataset.id }); sound.play('tick'); }
    if (a === 'ready') send('ready');
    if (a === 'place' && pending && send('place', pending)) { sound.play('send'); buzz(30); }
    if (a === 'lantern') { send('lantern', { target: el.dataset.id }); sound.play('chime'); }
    if (a === 'vote') { send('vote', { target: el.dataset.id }); sound.play('send'); buzz(30); }
    if (a === 'again') send('again');
    if (a === 'share') { const msg = await FX.share(shareText(), 'The Stowaway'); if (msg) toast(msg); }
    if (a === 'skip') send('skip');
  });

  // Tap (or click) the open chart to move your lantern; arrow keys nudge it and Enter lights it.
  play.addEventListener('pointerdown', e => {
    const field = e.target.closest('.chart-field.placing'); if (!field) return;
    const r = field.getBoundingClientRect();
    setPending((e.clientX - r.left) / r.width * 100, 100 - (e.clientY - r.top) / r.height * 100);
    sound.play('tick');
    play.querySelector('.chart-field.placing')?.focus({ preventScroll: true });
  });
  play.addEventListener('keydown', e => {
    if (!e.target.closest?.('.chart-field.placing')) return;
    const step = e.shiftKey ? 10 : 4, p = pending || { x: 50, y: 50 };
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); setPending(p.x + moves[e.key][0], p.y + moves[e.key][1]); play.querySelector('.chart-field.placing')?.focus({ preventScroll: true }); }
    if (e.key === 'Enter' && pending) { e.preventDefault(); if (send('place', pending)) sound.play('send'); }
  });

  // Rejoin automatically after a refresh with the stored session token (PRD FE-9).
  if (saved.token && saved.code && (!urlCode || urlCode === saved.code)) { silentJoin = true; connect({ type: 'join', code: saved.code, token: saved.token, name: saved.name }); }
})();
