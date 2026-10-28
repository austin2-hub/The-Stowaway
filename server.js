const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3001;
const ROOT = __dirname;

// Word packs: [groupWord, stowawayWord, ...older clue hints, now unused].
const PACKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'pairs.json'), 'utf8'));
PACKS.Mixed = Object.values(PACKS).flat();
const PACK_NAMES = Object.keys(PACKS);  // includes Mixed
// The Night Chart: each word is rated 0-9 on six common axes and two per pack. Ratings guide the bots and pick the charts.
const CHART = JSON.parse(fs.readFileSync(path.join(ROOT, 'chart.json'), 'utf8'));
const PAIR_PACK = new Map(Object.entries(PACKS).filter(([n]) => n !== 'Mixed').flatMap(([n, pairs]) => pairs.map(p => [p[0] + '|' + p[1], n])));

// Timers and limits (PRD sections 3 and 6). TIME_SCALE speeds every timer up for automated tests.
const SCALE = Number(process.env.TIME_SCALE) || 1;
const TICKET_MS = 8000 * SCALE, CHART_MS = 30000 * SCALE, LIT_MS = 8000 * SCALE, ALL_LIT_MS = 1200 * SCALE, DISCUSS_MS = 45000 * SCALE, VOTE_MS = 20000 * SCALE, REVEAL_MS = 9000 * SCALE, GUESS_MS = 15000 * SCALE, SCORES_MS = 9000 * SCALE, VOID_MS = 5000 * SCALE;
const ALL_VOTED_MS = 3000 * SCALE, MIN_PLAYERS = 3, MAX_PLAYERS = 8, MAX_ROOMS = 200, ROUND_CHOICES = [3, 5, 7];
const AWAY_LIMIT_MS = 60000 * SCALE, STOWAWAY_GRACE_MS = 15000 * SCALE, HOST_GRACE_MS = 15000 * SCALE, PAUSE_LIMIT_MS = 120000 * SCALE, ROOM_IDLE_MS = 30 * 60 * 1000;
const BOT_NAMES = ['Agnes', 'Barnaby', 'Clement', 'Dorothea', 'Ezra'];
const LIVE_PHASES = ['tickets', 'chart', 'lit', 'discuss', 'vote'];
const CHARTS = 2;

// Profanity and slur blocklist, ROT13-encoded to keep the source readable. Matches whole words and simple inflections.
const BLOCKED = new Set('shpx shpxre shpxvat shpxrq zbgureshpxre fuvg fuvggl ohyyfuvg phag onfgneq qvpx qvpxurnq juber fyhg gjng jnax jnaxre cvff nffubyr nefrubyr obyybpxf avttre avttn snttbg snt ergneq xvxr puvax fcvp genaal jrgonpx tbbx qnza ovgpu'
  .split(' ').map(w => w.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 84) % 26 + 97))));
const isBlocked = word => BLOCKED.has(word) || ['s', 'es', 'ed', 'ing', 'er', 'ers', 'y'].some(end => word.endsWith(end) && BLOCKED.has(word.slice(0, -end.length)));

const rooms = new Map();
const createLog = new Map();

// Only the game's own files are public; server source and word lists stay private.
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/fx.js': 'fx.js', '/style.css': 'style.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const file = PUBLIC_FILES[pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(ROOT, file)).pipe(res);
});

// Minimal RFC 6455 text socket support keeps the game dependency-free.
function frame(opcode, payload = Buffer.alloc(0)) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}
class Peer {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.readyState = 1; this.handlers = {}; this.recent = [];
    socket.on('data', chunk => this.consume(chunk));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  on(name, fn) { (this.handlers[name] ??= []).push(fn); }
  emit(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
  send(data) { if (this.readyState === 1) this.socket.write(frame(1, data)); }
  close() { if (this.readyState !== 1) return; this.socket.end(frame(8)); this.closed(); }
  closed() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 15, masked = !!(this.buffer[1] & 128);
      let len = this.buffer[1] & 127, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; const big = this.buffer.readBigUInt64BE(2); if (big > 4096n) return this.close(); len = Number(big); offset = 10; }
      if (len > 4096) return this.close();
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + len) return;
      let data = this.buffer.subarray(offset + maskBytes, offset + maskBytes + len);
      if (masked) { data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= this.buffer[offset + (i % 4)]; }
      this.buffer = this.buffer.subarray(offset + maskBytes + len);
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.socket.write(frame(10, data)); continue; }
      if (opcode === 1) this.emit('message', data);
    }
  }
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const peer = new Peer(socket);
  peer.ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  peer.on('message', buf => {
    // PRD 6.5: at most 10 events per second per socket.
    const now = Date.now();
    peer.recent = peer.recent.filter(t => now - t < 1000);
    if (peer.recent.length >= 10) return send(peer, 'error', { message: 'Easy there, passenger. One thing at a time.' });
    peer.recent.push(now);
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return send(peer, 'error', { message: 'The purser could not read that. Try again.' }); }
    if (msg && typeof msg === 'object') handle(peer, msg);
  });
  peer.on('close', () => onDisconnect(peer));
});

const uid = () => crypto.randomBytes(12).toString('hex');
const pick = list => list[crypto.randomInt(list.length)];
const shuffle = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const send = (ws, type, data = {}) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type, ...data })); };
const cleanName = value => String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
const normal = value => String(value ?? '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const newCode = () => { let c; do { c = ''; for (let i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]; } while (rooms.has(c)); return c; };
const roster = room => [...room.players.values()];
const sailors = room => roster(room).filter(p => !p.spectator && p.inRound);
const present = room => roster(room).filter(p => p.connected && !p.spectator);
const humans = room => roster(room).filter(p => p.connected && !p.isBot);

// ---------- State sent to each client. Nothing secret leaves the server before the reveal. ----------
function viewFor(room, viewer) {
  const d = room.round;
  const phase = room.phase;
  const afterVote = ['reveal', 'guess', 'scores', 'final'].includes(phase) && d && !d.voided;
  const view = {
    code: room.code, phase, hostId: room.hostId, serverNow: Date.now(), endsAt: room.endsAt, phaseMs: room.phaseMs,
    pack: room.pack, packs: PACK_NAMES, totalRounds: room.totalRounds, roundNumber: room.roundNumber,
    paused: room.paused ? { since: room.paused.since, until: room.paused.since + PAUSE_LIMIT_MS } : null,
    players: roster(room).map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, spectator: p.spectator, isBot: p.isBot, inRound: !!p.inRound })),
    history: room.history,
    me: viewer ? { id: viewer.id, lanternUsed: !!viewer.lanternUsed, lanterns: viewer.lanternLog || [], ticket: (d && viewer.inRound && !viewer.spectator && phase !== 'lobby' && phase !== 'final') ? viewer.ticket : null } : null,
  };
  if (d) {
    view.round = {
      order: d.order, chart: d.chart, charts: d.charts.map(c => ({ x: c.x.labels, y: c.y.labels })),
      // Lanterns stay dark until the whole chart is lit; while placing, you see only your own and who has placed.
      marks: d.marks.map((m, i) => i < d.chart || (i === d.chart && phase !== 'chart') ? m : viewer && m[viewer.id] ? { [viewer.id]: m[viewer.id] } : {}),
      placed: d.chart >= 0 ? Object.keys(d.marks[d.chart]) : [],
      suspicions: phase === 'discuss' || afterVote ? d.suspicions : {},
      lanterns: d.lanterns,
      ready: Object.keys(d.ready),
      voted: Object.keys(d.votes),
      myVote: viewer ? d.votes[viewer.id] || null : null,
      voided: d.voided || null,
    };
    if (afterVote) {
      Object.assign(view.round, {
        votes: d.votes, tally: d.tally, accusedId: d.accusedId, caught: d.caught, stowawayId: d.stowawayId,
        stowawayWord: d.stowawayWord, deltas: d.deltas, guess: d.guess, guessRight: d.guessRight,
        // While the caught stowaway is guessing, the group word stays hidden from everyone's payload.
        groupWord: d.caught && (phase === 'reveal' || phase === 'guess') ? null : d.groupWord,
      });
    }
  }
  return view;
}
function broadcast(room) {
  for (const p of room.players.values()) if (p.connected && !p.isBot) send(p.ws, 'state', { state: viewFor(room, p) });
}
function setTimer(room, ms) { room.endsAt = Date.now() + ms; room.phaseMs = ms; }

// ---------- Rooms and players ----------
function makePlayer(name, ws, extra = {}) {
  return { id: uid(), token: uid(), name, ws, connected: !!ws || !!extra.isBot, awaySince: null, score: 0, spectator: false, inRound: false, isBot: false, joinedAt: Date.now(), ...extra };
}
function createRoom(ws, name, practice) {
  if (rooms.size >= MAX_ROOMS) return send(ws, 'error', { message: 'All ferries are in service. Try again in a few minutes.' });
  const host = makePlayer(name, ws);
  const room = { code: newCode(), hostId: host.id, hostGraceUntil: null, players: new Map([[host.id, host]]), phase: 'lobby', pack: 'Food', totalRounds: 5,
    roundNumber: 0, round: null, history: [], usedPairs: new Set(), endsAt: null, phaseMs: 0, paused: null, activity: Date.now() };
  rooms.set(room.code, room);
  if (practice) { addBot(room); addBot(room); }
  attach(ws, room, host);
  broadcast(room);
}
function addBot(room) {
  const used = new Set(roster(room).map(p => p.name));
  const name = BOT_NAMES.find(n => !used.has(n));
  if (!name || room.players.size >= MAX_PLAYERS) return;
  const bot = makePlayer(name, null, { isBot: true, token: null });
  room.players.set(bot.id, bot);
}
function attach(ws, room, player) {
  ws.player = { room: room.code, id: player.id };
  send(ws, 'joined', { code: room.code, token: player.token, id: player.id });
}

// ---------- Round flow: TICKETS > CLUES > DISCUSS > VOTE > REVEAL > (GUESS) > SCORES ----------
function startRound(room) {
  for (const p of room.players.values()) { p.spectator = !p.connected; p.inRound = p.connected; }
  const crew = sailors(room);
  if (crew.length < MIN_PLAYERS) { toLobby(room, 'Three passengers are needed to sail.'); return; }
  const pack = PACKS[room.pack];
  let fresh = pack.filter(pair => !room.usedPairs.has(pair[0] + '|' + pair[1]));
  if (!fresh.length) { room.usedPairs.clear(); fresh = pack; }
  const [groupWord, stowawayWord] = pick(fresh);
  room.usedPairs.add(groupWord + '|' + stowawayWord);
  const stowaway = pick(crew);
  room.roundNumber++;
  room.round = { groupWord, stowawayWord, stowawayId: stowaway.id, order: shuffle(crew.map(p => p.id)), pack: PAIR_PACK.get(groupWord + '|' + stowawayWord),
    charts: drawCharts(groupWord, stowawayWord, PAIR_PACK.get(groupWord + '|' + stowawayWord)), chart: -1, marks: Array.from({ length: CHARTS }, () => ({})),
    suspicions: {}, lanterns: [], ready: {}, votes: {}, deltas: {}, guess: null };
  for (const p of crew) { p.ticket = p.id === stowaway.id ? stowawayWord : groupWord; p.botAt = null; }
  room.phase = 'tickets';
  setTimer(room, TICKET_MS);
  broadcast(room);
}
// Each chart pairs the axis that best splits this round's two words with a random one, so the stowaway's lantern can drift.
function drawCharts(groupWord, stowawayWord, pack) {
  const axes = [...CHART.axes.common, ...(CHART.axes[pack] || [])];
  const a = CHART.ratings[groupWord], b = CHART.ratings[stowawayWord];
  const gap = i => a && b ? Math.abs(a[i] - b[i]) : 0;
  const ranked = shuffle(axes.map((_, i) => i)).sort((i, j) => gap(j) - gap(i));
  const others = shuffle(ranked.slice(CHARTS));
  return Array.from({ length: CHARTS }, (_, n) => {
    const pair = shuffle([ranked[n], others[n]]);
    return { x: { i: pair[0], labels: axes[pair[0]] }, y: { i: pair[1], labels: axes[pair[1]] } };
  });
}
function beginChart(room, index) {
  const d = room.round;
  d.chart = index;
  room.phase = 'chart';
  setTimer(room, CHART_MS);
  scheduleBots(room);
  broadcast(room);
}
// Every lantern on the chart lights at once.
function lightChart(room) {
  room.phase = 'lit';
  setTimer(room, LIT_MS);
  broadcast(room);
}
function placeLantern(room, player, x, y) {
  const d = room.round;
  const marks = d.marks[d.chart];
  if (marks[player.id]) return 'Your lantern is already lit on this chart.';
  if (![x, y].every(v => Number.isFinite(v) && v >= 0 && v <= 100)) return 'Tap a spot on the chart.';
  marks[player.id] = { x: Math.round(x), y: Math.round(y) };
  checkAllPlaced(room);
  broadcast(room);
  return null;
}
function checkAllPlaced(room) {
  const d = room.round;
  if (room.phase === 'chart' && present(room).filter(p => p.inRound).every(p => d.marks[d.chart][p.id])) room.endsAt = Math.min(room.endsAt, Date.now() + ALL_LIT_MS);
}
function beginVote(room) {
  room.phase = 'vote';
  setTimer(room, VOTE_MS);
  scheduleBots(room);
  broadcast(room);
}
function reveal(room) {
  const d = room.round;
  const tally = {};
  for (const target of Object.values(d.votes)) tally[target] = (tally[target] || 0) + 1;
  const top = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter(id => tally[id] === top);
  // The single most-voted passenger is put ashore. A tie (or no votes) puts nobody ashore.
  d.tally = tally;
  d.accusedId = top > 0 && leaders.length === 1 ? leaders[0] : null;
  d.caught = d.accusedId === d.stowawayId;
  const award = (id, pts) => { const p = room.players.get(id); if (!p) return; p.score += pts; d.deltas[id] = (d.deltas[id] || 0) + pts; };
  for (const [voter, target] of Object.entries(d.votes)) if (target === d.stowawayId) award(voter, 100);
  if (!d.caught) award(d.stowawayId, 200);
  room.phase = 'reveal';
  setTimer(room, REVEAL_MS);
  broadcast(room);
}
function finishGuess(room) {
  const d = room.round;
  d.guessRight = !!d.guess && normal(d.guess) === normal(d.groupWord);
  if (d.guessRight) { const p = room.players.get(d.stowawayId); if (p) { p.score += 100; d.deltas[p.id] = (d.deltas[p.id] || 0) + 100; } }
  toScores(room);
}
function toScores(room) {
  const d = room.round;
  const stowaway = room.players.get(d.stowawayId);
  room.history.push({ number: room.roundNumber, stowaway: stowaway?.name || 'A passenger', groupWord: d.groupWord, stowawayWord: d.stowawayWord, caught: d.caught, guessRight: !!d.guessRight });
  const last = room.roundNumber >= room.totalRounds;
  room.phase = last ? 'final' : 'scores';
  if (last) { room.endsAt = null; room.phaseMs = 0; } else setTimer(room, SCORES_MS);
  broadcast(room);
}
function voidRound(room, reason) {
  room.round.voided = reason;
  room.roundNumber--;
  room.phase = 'scores';
  setTimer(room, VOID_MS);
  broadcast(room);
}
function toLobby(room, message) {
  room.phase = 'lobby'; room.round = null; room.endsAt = null; room.paused = null;
  for (const p of room.players.values()) { p.spectator = false; p.inRound = false; }
  broadcast(room);
  if (message) for (const p of humans(room)) send(p.ws, 'notice', { message });
}
function advance(room) {
  const d = room.round;
  switch (room.phase) {
    case 'tickets': beginChart(room, 0); break;
    case 'chart': lightChart(room); break;
    case 'lit': if (d.chart + 1 < CHARTS) beginChart(room, d.chart + 1); else { room.phase = 'discuss'; setTimer(room, DISCUSS_MS); scheduleBots(room); broadcast(room); } break;
    case 'discuss': beginVote(room); break;
    case 'vote': reveal(room); break;
    case 'reveal': if (d.caught) { room.phase = 'guess'; setTimer(room, GUESS_MS); scheduleBots(room); broadcast(room); } else toScores(room); break;
    case 'guess': finishGuess(room); break;
    case 'scores': startRound(room); break;
  }
}

// ---------- Practice bots ----------
function scheduleBots(room) {
  const now = Date.now();
  for (const bot of roster(room)) if (bot.isBot) {
    const wait = { chart: 3000 + crypto.randomInt(9000), discuss: 6000 + crypto.randomInt(14000), vote: 3000 + crypto.randomInt(9000), guess: 3500 + crypto.randomInt(4000) }[room.phase];
    bot.botAt = wait ? now + wait * SCALE : null;
  }
}
// A bot places its lantern where its own word sits on the two axes, with a little human wobble.
function botSpot(word, chart) {
  const r = CHART.ratings[word];
  const at = axis => Math.max(4, Math.min(96, Math.round((r ? r[axis.i] / 9 * 100 : 50) + (crypto.randomInt(21) - 10))));
  return { x: at(chart.x), y: at(chart.y) };
}
// How far each passenger's lanterns sit from everyone else's, summed over the lit charts. The odd one out scores highest.
function drift(room, id) {
  const d = room.round;
  let total = 0;
  for (const marks of d.marks.slice(0, d.chart + 1)) {
    const mine = marks[id], rest = Object.entries(marks).filter(([k]) => k !== id).map(([, m]) => m);
    if (!mine || !rest.length) continue;
    const cx = rest.reduce((n, m) => n + m.x, 0) / rest.length, cy = rest.reduce((n, m) => n + m.y, 0) / rest.length;
    total += Math.hypot(mine.x - cx, mine.y - cy);
  }
  return total;
}
function botSuspect(room, bot) {
  const others = room.round.order.filter(id => id !== bot.id);
  const ranked = [...others].sort((a, b) => drift(room, b) - drift(room, a));
  // Bots read the chart well but not perfectly.
  return crypto.randomInt(100) < 70 ? ranked[0] : pick(others);
}
function runBots(room, now) {
  const d = room.round;
  if (!d) return;
  for (const bot of roster(room)) {
    if (!bot.isBot || !bot.inRound || !bot.botAt || now < bot.botAt) continue;
    bot.botAt = null;
    if (room.phase === 'chart') {
      // On the second chart a stowaway bot sometimes works out the group's word and blends in.
      const word = bot.id === d.stowawayId && d.chart > 0 && crypto.randomInt(100) < 40 ? d.groupWord : bot.ticket;
      const spot = botSpot(word, d.charts[d.chart]);
      placeLantern(room, bot, spot.x, spot.y);
    } else if (room.phase === 'discuss') {
      d.suspicions[bot.id] = botSuspect(room, bot);
      const others = d.order.filter(id => id !== bot.id);
      if (!bot.lanternUsed && crypto.randomInt(100) < 35) useLantern(room, bot, room.players.get(pick(others)));
      d.ready[bot.id] = true;
      checkAllReady(room);
      broadcast(room);
    } else if (room.phase === 'vote') {
      d.votes[bot.id] = d.suspicions[bot.id] && d.suspicions[bot.id] !== bot.id ? d.suspicions[bot.id] : botSuspect(room, bot);
      checkAllVoted(room);
      broadcast(room);
    } else if (room.phase === 'guess' && bot.id === d.stowawayId) {
      const pack = PACKS[d.pack] || PACKS.Mixed;
      d.guess = crypto.randomInt(100) < 40 ? d.groupWord : pick(pack.flatMap(p => p.slice(0, 2)).filter(w => w !== d.stowawayWord));
      finishGuess(room);
    }
  }
}
function useLantern(room, player, target) {
  player.lanternUsed = true;
  (player.lanternLog ||= []).push({ round: room.roundNumber, target: target.id, same: target.ticket === player.ticket });
  room.round.lanterns.push({ by: player.id, target: target.id });
}
function checkAllReady(room) {
  const d = room.round;
  if (room.phase === 'discuss' && present(room).filter(p => p.inRound).every(p => d.ready[p.id])) beginVote(room);
}
function checkAllVoted(room) {
  const d = room.round;
  if (room.phase !== 'vote') return;
  if (present(room).filter(p => p.inRound).every(p => d.votes[p.id])) room.endsAt = Math.min(room.endsAt, Date.now() + ALL_VOTED_MS);
}

// ---------- Messages from clients ----------
function handle(ws, msg) {
  const now = Date.now();
  if (msg.type === 'create' || msg.type === 'practice') {
    const name = cleanName(msg.name);
    if (name.length < 2) return send(ws, 'error', { message: 'Use a passenger name of 2 to 14 characters.' });
    const recent = (createLog.get(ws.ip) || []).filter(t => now - t < 60000);
    if (recent.length >= 5) return send(ws, 'error', { message: 'The purser needs a minute before opening another crossing.' });
    recent.push(now); createLog.set(ws.ip, recent);
    return createRoom(ws, name, msg.type === 'practice');
  }
  if (msg.type === 'join') {
    const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
    if (!room) return send(ws, 'error', { message: 'No ferry sails under that code.', code: 'no-room' });
    const returning = msg.token && roster(room).find(p => p.token === msg.token);
    if (returning) {
      if (returning.connected && returning.ws && returning.ws !== ws) send(returning.ws, 'error', { message: 'You boarded from another tab. This one is now ashore.', code: 'replaced' });
      returning.ws = ws; returning.connected = true; returning.awaySince = null;
      room.activity = now;
      attach(ws, room, returning);
      return broadcast(room);
    }
    const name = cleanName(msg.name);
    if (name.length < 2) return send(ws, 'error', { message: 'Use a passenger name of 2 to 14 characters.' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, 'error', { message: 'The ferry is full. Ask the host to start a new crossing.' });
    const taken = new Set(roster(room).map(p => p.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let n = 2; while (taken.has((name.slice(0, 13) + n).toLowerCase())) n++;
      return send(ws, 'error', { message: `${name} is already aboard. Try ${name.slice(0, 13)}${n}.`, code: 'name-taken', suggestion: name.slice(0, 13) + n });
    }
    const player = makePlayer(name, ws, { spectator: room.phase !== 'lobby' });
    room.players.set(player.id, player);
    if (!room.players.get(room.hostId)) room.hostId = player.id;
    room.activity = now;
    attach(ws, room, player);
    return broadcast(room);
  }

  const room = ws.player && rooms.get(ws.player.room);
  const player = room?.players.get(ws.player.id);
  if (!room || !player || player.ws !== ws) return send(ws, 'error', { message: 'Board the ferry first.', code: 'no-room' });
  room.activity = now;
  const d = room.round;
  const isHost = player.id === room.hostId;

  switch (msg.type) {
    case 'leave':
      room.players.delete(player.id); ws.player = null;
      afterDeparture(room, player);
      return;
    case 'pack':
      if (isHost && room.phase === 'lobby' && PACKS[msg.pack]) { room.pack = msg.pack; room.usedPairs.clear(); broadcast(room); }
      return;
    case 'rounds':
      if (isHost && room.phase === 'lobby' && ROUND_CHOICES.includes(Number(msg.rounds))) { room.totalRounds = Number(msg.rounds); broadcast(room); }
      return;
    case 'addBot':
      if (isHost && room.phase === 'lobby') { addBot(room); broadcast(room); }
      return;
    case 'removeBot': {
      const bot = room.players.get(msg.id);
      if (isHost && room.phase === 'lobby' && bot?.isBot) { room.players.delete(bot.id); broadcast(room); }
      return;
    }
    case 'start':
      if (!isHost || room.phase !== 'lobby') return;
      if (roster(room).filter(p => p.connected).length < MIN_PLAYERS) return send(ws, 'error', { message: 'Three passengers are needed to sail. Add a bot or share the code.' });
      for (const p of room.players.values()) p.score = 0;
      room.roundNumber = 0; room.history = [];
      for (const p of room.players.values()) { p.lanternUsed = false; p.lanternLog = []; }
      return startRound(room);
    case 'place': {
      if (room.phase !== 'chart' || room.paused || !player.inRound || player.spectator) return send(ws, 'reject', { message: 'The chart is not open right now.' });
      const problem = placeLantern(room, player, Number(msg.x), Number(msg.y));
      if (problem) send(ws, 'reject', { message: problem });
      return;
    }
    case 'lantern': {
      // The Purser's Lantern: once per voyage, privately learn whether one passenger's ticket matches yours.
      if (room.phase !== 'discuss' || room.paused || !player.inRound || player.spectator) return;
      if (player.lanternUsed) return send(ws, 'reject', { message: 'Your lantern is spent for this voyage.' });
      const target = room.players.get(msg.target);
      if (!target || target.id === player.id || !d.order.includes(target.id)) return send(ws, 'reject', { message: 'Shine it on another passenger.' });
      useLantern(room, player, target);
      return broadcast(room);
    }
    case 'suspect':
      if (room.phase !== 'discuss' || !player.inRound) return;
      if (msg.target === null || msg.target === d.suspicions[player.id]) delete d.suspicions[player.id];
      else if (d.order.includes(msg.target) && msg.target !== player.id) d.suspicions[player.id] = msg.target;
      return broadcast(room);
    case 'ready':
      if (room.phase !== 'discuss' || !player.inRound) return;
      if (d.ready[player.id]) delete d.ready[player.id]; else d.ready[player.id] = true;
      broadcast(room);
      return checkAllReady(room);
    case 'vote':
      // Votes can be changed until the bell (PRD FE-5). Self-votes and votes for non-passengers are refused.
      if (room.phase !== 'vote' || room.paused || !player.inRound || player.spectator) return;
      if (msg.target === player.id || !d.order.includes(msg.target)) return send(ws, 'reject', { message: 'Choose another passenger.' });
      d.votes[player.id] = msg.target;
      checkAllVoted(room);
      return broadcast(room);
    case 'guess':
      if (room.phase !== 'guess' || player.id !== d.stowawayId || d.guess) return;
      d.guess = String(msg.word ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
      if (!d.guess) { d.guess = null; return send(ws, 'reject', { message: 'Write a guess first.' }); }
      if (d.guess.toLowerCase().split(/[^a-z]+/).some(isBlocked)) { d.guess = null; return send(ws, 'reject', { message: 'The purser will not print that. Guess again.' }); }
      return finishGuess(room);
    case 'again':
      if (!isHost || room.phase !== 'final') return;
      for (const p of room.players.values()) p.score = 0;
      room.roundNumber = 0; room.history = [];
      for (const p of room.players.values()) { p.lanternUsed = false; p.lanternLog = []; }
      return toLobby(room);
    case 'skip':
      // The host can end a stuck pause by sailing back to the lobby.
      if (isHost && room.paused) toLobby(room, 'The purser has called everyone back to the manifest.');
      return;
  }
}

function onDisconnect(ws) {
  const room = ws.player && rooms.get(ws.player.room);
  const player = room?.players.get(ws.player.id);
  if (!player || player.ws !== ws) return;
  player.connected = false; player.awaySince = Date.now(); player.ws = null;
  afterDeparture(room, player);
}
function afterDeparture(room, player) {
  if (player.id === room.hostId) {
    // A host who left on purpose hands over at once; a dropped host gets a short grace to refresh.
    if (!room.players.has(player.id)) passHost(room); else room.hostGraceUntil = Date.now() + HOST_GRACE_MS;
  }
  const d = room.round;
  if (d && LIVE_PHASES.includes(room.phase) && room.phase !== 'tickets') {
    if (room.phase === 'chart') checkAllPlaced(room);
    if (room.phase === 'vote') checkAllVoted(room);
    if (room.phase === 'discuss') checkAllReady(room);
  }
  if (!room.players.has(player.id) && d?.stowawayId === player.id && LIVE_PHASES.includes(room.phase)) { voidRound(room, 'The stowaway jumped ship. This crossing does not count.'); return; }
  broadcast(room);
}
function passHost(room) {
  const next = roster(room).filter(p => p.connected && !p.isBot).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  room.hostGraceUntil = null;
  if (next) room.hostId = next.id;
}

// ---------- One clock drives every room ----------
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!humans(room).length) {
      room.emptySince ??= now;
      if (now - room.emptySince > 10 * 60 * 1000) { rooms.delete(code); continue; }
    } else room.emptySince = null;
    if (now - room.activity > ROOM_IDLE_MS) { rooms.delete(code); continue; }

    let changed = false;
    if (room.hostGraceUntil && now > room.hostGraceUntil) {
      if (!room.players.get(room.hostId)?.connected) passHost(room); else room.hostGraceUntil = null;
      changed = true;
    }
    if (room.phase === 'lobby') {
      // Passengers who never return are struck off the manifest after a minute.
      for (const p of roster(room)) if (!p.connected && !p.isBot && now - p.awaySince > AWAY_LIMIT_MS) { room.players.delete(p.id); changed = true; if (p.id === room.hostId) passHost(room); }
      if (changed) broadcast(room);
      continue;
    }
    const d = room.round;
    // PRD 6.4: if the stowaway stays away, the round is voided.
    if (d && LIVE_PHASES.includes(room.phase)) {
      const stowaway = room.players.get(d.stowawayId);
      if (!stowaway || (!stowaway.connected && now - stowaway.awaySince > STOWAWAY_GRACE_MS)) { voidRound(room, 'The stowaway slipped overboard. This crossing does not count.'); continue; }
    }
    // PRD 6.4: under three connected passengers, the crossing pauses.
    const aboard = present(room).filter(p => p.inRound).length;
    if (LIVE_PHASES.includes(room.phase) && aboard < MIN_PLAYERS && !room.paused) {
      room.paused = { since: now, remaining: Math.max(0, room.endsAt - now) };
      broadcast(room); continue;
    }
    if (room.paused) {
      if (aboard >= MIN_PLAYERS) {
        room.endsAt = now + room.paused.remaining;
        room.paused = null; broadcast(room);
      } else if (now - room.paused.since > PAUSE_LIMIT_MS) toLobby(room, 'Too few passengers came back. The crossing returned to port.');
      else if (changed) broadcast(room);
      continue;
    }
    runBots(room, now);
    if (room.endsAt && now >= room.endsAt) advance(room);
    else if (changed) broadcast(room);
  }
}, 200).unref();

server.listen(PORT, () => console.log(`The Stowaway is sailing at http://localhost:${PORT}`));
