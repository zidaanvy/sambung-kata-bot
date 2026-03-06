/**
 * WhatsApp Word Chain Bot (Sambung Kata)
 * Library: whatsapp-web.js
 *
 * FLOW:
 *  1. !start → host pilih gamemode (balas angka)
 *  2. Fase join 15 detik → pemain ketik !join
 *  3. Game mulai, giliran berurutan sesuai urutan join
 *
 * GAMEMODES:
 *  - Bahasa: Indonesia (KBBI) atau Inggris (Dictionary API + terjemahan)
 *  - Timer: ON (15 detik/giliran) atau OFF
 *
 * LEVELS:
 *  - Level 1:  sambung 1 huruf terakhir
 *  - Level 2: sambung 2 huruf terakhir
 *  - Level 3:  sambung 3 huruf terakhir
 *
 * LIVES:
 *  - Setiap pemain punya 2 nyawa
 *  - Salah / timeout → nyawa -1, giliran pindah ke berikutnya
 *  - Habis nyawa → eliminated
 *  - Game over saat ≤1 pemain aktif
 *
 * COMMANDS:
 *  !start  — mulai setup game
 *  !join   — join game (fase join saja)
 *  !stop   — hentikan game
 *  !score  — leaderboard
 *  !lives  — status nyawa
 *  !words  — cari contoh kata di kamus berdasarkan awalan (contoh: !words be)
 *  !level  — info level & suffix saat ini
 *  !reset  — reset semua
 *  !help   — tampilkan aturan
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// ─── LOCAL ENGLISH DICTIONARY + TRANSLATIONS ──────────────────────────────
// words.txt dan words_indonesian.txt harus urutan line yang sama
const ENGLISH_WORDS_ARR = fs.readFileSync(path.join(__dirname, 'words.txt'), 'utf8')
  .split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(Boolean);

const ENGLISH_WORDS = new Set(ENGLISH_WORDS_ARR);

const ID_TRANSLATIONS_ARR = fs.readFileSync(path.join(__dirname, 'words_indonesian.txt'), 'utf8')
  .split(/\r?\n/).map(w => w.trim()).filter((_, i) => i < ENGLISH_WORDS_ARR.length);

// Map: english word → indonesian translation (O(1) lookup)
const EN_TO_ID = new Map();
ENGLISH_WORDS_ARR.forEach((word, i) => {
  const trans = ID_TRANSLATIONS_ARR[i];
  if (trans && trans.toLowerCase() !== word.toLowerCase()) {
    EN_TO_ID.set(word, trans);
  }
});

console.log(`✅ Kamus Inggris dimuat: ${ENGLISH_WORDS.size.toLocaleString()} kata`);
console.log(`✅ Terjemahan dimuat   : ${EN_TO_ID.size.toLocaleString()} kata`);

function getTranslation(word) {
  return EN_TO_ID.get(word.toLowerCase()) ?? null;
}

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MAX_LIVES      = 2;
const JOIN_SECONDS   = 15;
const TIMER_SECONDS  = 15;

// Level naik jika KEDUA syarat terpenuhi (wordCount DAN loopCount)
const LEVEL_THRESHOLDS = [
  { level: 1, suffixLen: 1, label: 'Level 1 (1 huruf)', minWords: 0,  minLoops: 0 },
  { level: 2, suffixLen: 2, label: 'Level 2 (2 huruf)', minWords: 10, minLoops: 2 },
  { level: 3, suffixLen: 3, label: 'Level 3 (3 huruf)', minWords: 30, minLoops: 4 },
];

// ─── STATE ─────────────────────────────────────────────────────────────────
const games = {};

function createGame() {
  return {
    // phase: 'idle' | 'setup' | 'joining' | 'active'
    phase: 'idle',

    // setup
    hostId:   null,
    hostName: null,
    lang:     null,   // 'id' | 'en'
    timerOn:  null,   // true | false

    // join
    joinOrder: [],    // [{ id, name }] in join order
    joinTimer: null,

    // gameplay
    wordCount:         0,
    loopCount:         0,    // berapa kali semua pemain aktif sudah dapat giliran
    lastWord:          null,
    lastAcceptedPlayer: null, // { id, name } pemain yang terakhir berhasil menjawab (penembak)
    effectiveSuffixLen: null,
    usedWords:         new Set(),
    currentTurnId:     null, // ID pemain yang sedang giliran
    turnTimer:         null,

    // per-player data
    // scores: { id: { name, points, lives, eliminated } }
    scores: {},

    // history of accepted words (last 20)
    wordHistory: [],  // [{ word, playerName }]

    // suffix override after wrong answer (null = use normal suffix)
    suffixOverride: null,  // { suffix, suffixLen } — forced suffix for next turn
  };
}

function getGame(groupId) {
  if (!games[groupId]) games[groupId] = createGame();
  return games[groupId];
}

function getCurrentLevel(wordCount, loopCount) {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    const t = LEVEL_THRESHOLDS[i];
    if (wordCount >= t.minWords && loopCount >= t.minLoops) return t;
  }
  return LEVEL_THRESHOLDS[0];
}

function livesBar(lives) {
  // 2 nyawa penuh: ❤️❤️
  // 1 nyawa (berkurang 1): ❤️🩶
  // 0 nyawa (habis): 🩶🩶
  const full = Math.max(0, lives);
  const broken = MAX_LIVES - full;
  return '❤️'.repeat(full) + '🩶'.repeat(broken);
}

// Random kill notification messages
const KILL_MESSAGES = [
  (shooter, victim) => `🔫 *${shooter}* menembak *${victim}*!`,
  (shooter, victim) => `🗡️ *${shooter}* menusuk *${victim}*!`,
  (shooter, victim) => `💣 *${shooter}* meledakkan *${victim}*!`,
  (shooter, victim) => `⚡ *${shooter}* menyambar *${victim}* dengan petir!`,
  (shooter, victim) => `🔪 *${shooter}* menghabisi *${victim}*!`,
  (shooter, victim) => `🪤 *${shooter}* menjebak *${victim}*!`,
];

function randomKillMsg(shooterName, victimName) {
  const fn = KILL_MESSAGES[Math.floor(Math.random() * KILL_MESSAGES.length)];
  return fn(shooterName, victimName);
}

// ─── STARTER WORDS ─────────────────────────────────────────────────────────
const STARTER_WORDS_EN = [
  'apple', 'bridge', 'cloud', 'dream', 'eagle', 'flame', 'garden', 'horizon',
  'island', 'jungle', 'kingdom', 'lantern', 'mountain', 'nature', 'ocean',
  'planet', 'quest', 'river', 'shadow', 'temple', 'universe', 'valley',
  'winter', 'yellow', 'zebra', 'forest', 'castle', 'dragon', 'empire', 'frozen',
];

const STARTER_WORDS_ID = [
  'api', 'buku', 'cahaya', 'daun', 'elang', 'fajar', 'gunung', 'hujan',
  'ikan', 'jalan', 'kapal', 'langit', 'matahari', 'naga', 'ombak',
  'pasir', 'rimba', 'salju', 'taman', 'udara', 'voli', 'waktu',
  'angin', 'bulan', 'cinta', 'desa', 'embun', 'bintang', 'bunga', 'danau',
];

function getStarterWord(lang) {
  const list = lang === 'id' ? STARTER_WORDS_ID : STARTER_WORDS_EN;
  return list[Math.floor(Math.random() * list.length)];
}

function getSuffix(word, len) {
  return word.slice(-len).toLowerCase();
}



// ─── TURN ORDER ────────────────────────────────────────────────────────────
/** Returns the player whose turn it is (skip eliminated). */
function getCurrentTurnPlayer(game) {
  const active = game.joinOrder.filter(p => !game.scores[p.id]?.eliminated);
  if (active.length === 0) return null;
  // Cari pemain dengan ID yang sedang giliran
  const current = active.find(p => p.id === game.currentTurnId);
  // Jika tidak ditemukan (belum set / sudah eliminated), pakai yang pertama
  return current ?? active[0];
}

/** Advance turn to next active player, increment loopCount on full rotation. */
function advanceTurn(game) {
  const active = game.joinOrder.filter(p => !game.scores[p.id]?.eliminated);
  if (active.length === 0) return;
  const currentIdx = active.findIndex(p => p.id === game.currentTurnId);
  const nextIdx = (currentIdx + 1) % active.length;
  // Jika balik ke index 0, berarti satu loop selesai
  if (nextIdx === 0) game.loopCount++;
  game.currentTurnId = active[nextIdx].id;
}

// ─── DICTIONARY / VALIDATION ───────────────────────────────────────────────
function isEnglishWord(word) {
  return ENGLISH_WORDS.has(word.toLowerCase());
}



async function isIndonesianWord(word) {
  // Try multiple KBBI endpoints — fail open if all unreachable
  const endpoints = [
    `https://kbbi.vercel.app/api/${word.toLowerCase()}`,
    `https://kbbi-api.vercel.app/api/search/${word.toLowerCase()}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      // Accept if array with entries, or object with 'arti'/'makna'/'lema' key
      if (Array.isArray(data) && data.length > 0) return true;
      if (data && (data.arti || data.makna || data.lema || data.kata)) return true;
    } catch { continue; }
  }
  return true; // fail open jika semua API tidak bisa diakses
}



async function validateWord(game, word) {
  if (game.lang === 'en') return isEnglishWord(word);
  return isIndonesianWord(word);
}

// ─── PREFIX DEAD-END CHECK ─────────────────────────────────────────────────
async function prefixHasPossibleWord(prefix, lang) {
  if (lang === 'en') {
    for (const w of ENGLISH_WORDS) {
      if (w.startsWith(prefix) && w.length > prefix.length) return true;
    }
    return false;
  }
  // ID — pakai API KBBI
  const endings = ['a', 'e', 'i', 'u', 'an', 'en', 'er', 'al', 's', 'nya'];
  const candidates = endings.map(e => prefix + e).filter(w => w.length >= 3);
  const checks = candidates.slice(0, 6).map(w => isIndonesianWord(w));
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

async function resolveEffectiveSuffix(lastWord, standardLen, lang) {
  for (let len = standardLen; len >= 1; len--) {
    const prefix = getSuffix(lastWord, len);
    if (await prefixHasPossibleWord(prefix, lang)) {
      return {
        suffixLen: len,
        note: len < standardLen
          ? `⚠️ Suffix diturunkan ke *"${prefix.toUpperCase()}"* (${len} huruf).`
          : null,
      };
    }
  }
  return { suffixLen: 1, note: null };
}

/**
 * When a player answers wrong, pick a new suffix from the SAME lastWord
 * by trying a different ending length or same length but shifted.
 * Returns { suffix, suffixLen, note }
 */
async function resolveAlternativeSuffix(lastWord, currentSuffixLen, lang) {
  const tried = new Set();
  const orders = [currentSuffixLen, currentSuffixLen - 1, currentSuffixLen + 1, 1, 2, 3];
  for (const len of orders) {
    if (len < 1 || len > lastWord.length || tried.has(len)) continue;
    tried.add(len);
    const prefix = getSuffix(lastWord, len);
    if (await prefixHasPossibleWord(prefix, lang)) {
      return { suffix: prefix, suffixLen: len };
    }
  }
  // Absolute fallback: 1 letter
  return { suffix: getSuffix(lastWord, 1), suffixLen: 1 };
}

// ─── SCOREBOARD / LIVES ────────────────────────────────────────────────────
function formatScoreboard(scores) {
  const entries = Object.values(scores);
  if (!entries.length) return '_(belum ada pemain)_';
  const alive   = entries.filter(e => !e.eliminated);
  const dead    = entries.filter(e => e.eliminated);
  const lines   = [
    ...alive.map(e => `✅ ${e.name} ${livesBar(e.lives)}`),
    ...dead.map(e  => `💀 ${e.name}`),
  ];
  return lines.join('\n');
}

function formatLives(scores) {
  const entries = Object.values(scores);
  if (!entries.length) return '_(belum ada pemain)_';
  return entries.map(e =>
    e.eliminated
      ? `💀 ${e.name} — Eliminated`
      : `${e.name} — Nyawa: ${livesBar(e.lives)}`
  ).join('\n');
}

function formatTurnOrder(game) {
  return game.joinOrder.map((p, i) => {
    const s = game.scores[p.id];
    const eliminated = s?.eliminated ? ' 💀' : '';
    return `${i + 1}. ${p.name}${eliminated}`;
  }).join('\n');
}

// ─── GAME OVER ─────────────────────────────────────────────────────────────
async function checkGameOver(chat, game) {
  const active = game.joinOrder.filter(p => !game.scores[p.id]?.eliminated);
  if (active.length <= 1) {
    clearTurnTimer(game);
    game.phase = 'idle';
    const winner = active[0];
    const winnerMsg = winner
      ? `🏆 Pemenang: *${winner.name}*!\n\n`
      : 'Semua pemain eliminated!\n\n';
    await chat.sendMessage(`🏁 *Game Over!*\n\n${winnerMsg}📊 *Hasil:*\n${formatScoreboard(game.scores)}`);
  }
}

// ─── TURN TIMER ────────────────────────────────────────────────────────────
function clearTurnTimer(game) {
  if (game.turnTimer) { clearTimeout(game.turnTimer); game.turnTimer = null; }
}

async function startTurnTimer(chat, game) {
  clearTurnTimer(game);
  if (!game.timerOn || game.phase !== 'active') return;

  const currentPlayer = getCurrentTurnPlayer(game);
  if (!currentPlayer) return;

  game.turnTimer = setTimeout(async () => {
    if (game.phase !== 'active') return;
    const p = game.scores[currentPlayer.id];
    if (!p || p.eliminated) return;

    p.lives--;
    const eliminated = p.lives <= 0;
    if (eliminated) p.eliminated = true;

    const shooter = game.lastAcceptedPlayer;
    let msg = '';
    if (shooter && shooter.id !== currentPlayer.id) {
      msg += randomKillMsg(shooter.name, currentPlayer.name) + '\n';
    }
    msg += `Nyawa tersisa: ${livesBar(Math.max(p.lives, 0))}\n\n`;
    msg += `⏰ *Waktu habis!* @${currentPlayer.id.split('@')[0]} tidak menjawab dalam ${TIMER_SECONDS} detik.`;
    if (eliminated) msg += '\n\n💀 Eliminated!';

    await chat.sendMessage(msg);

    const over = game.joinOrder.filter(pl => !game.scores[pl.id]?.eliminated);
    if (over.length <= 1) {
      await checkGameOver(chat, game);
      return;
    }

    advanceTurn(game);
    await announceNextTurn(chat, game, '⏭️ Giliran');
  }, TIMER_SECONDS * 1000);
}

async function announceNextTurn(chat, game, prefix = '') {
  if (game.phase !== 'active') return;
  const next = getCurrentTurnPlayer(game);
  if (!next) return;
  // Pastikan currentTurnId selalu ter-set
  game.currentTurnId = next.id;

  const level = getCurrentLevel(game.wordCount, game.loopCount);
  const effectiveLen = game.effectiveSuffixLen ?? level.suffixLen;

  // Use suffixOverride if set (after penalize), otherwise compute normally
  const suffix = game.suffixOverride
    ? game.suffixOverride.suffix
    : (game.lastWord ? getSuffix(game.lastWord, effectiveLen) : null);

  let msg = prefix
    ? `${prefix} *${next.name}*!`
    : `➡️ Giliran *${next.name}*!`;
  if (game.timerOn) msg += `\n⏱️ Waktu: ${TIMER_SECONDS} detik`;
  if (suffix) msg += `\n*${suffix.toUpperCase()}---*`;
  

  await chat.sendMessage(msg);
  await startTurnTimer(chat, game);
}

// ─── CLIENT ────────────────────────────────────────────────────────────────
const IS_RAILWAY   = !!process.env.RAILWAY_ENVIRONMENT;
const AUTH_PATH    = IS_RAILWAY ? '/data' : '.';
const CHROME_PATH  = process.env.PUPPETEER_EXECUTABLE_PATH
                  || (IS_RAILWAY ? '/usr/bin/chromium-browser' : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
  puppeteer: {
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

client.on('qr', qr => {
  console.log('\n📱 Scan QR code berikut dengan WhatsApp kamu:\n');
  qrcode.generate(qr, { small: true });
});

const BOT_START_TIME = Math.floor(Date.now() / 1000); // Unix timestamp detik

client.on('ready', () => {
  console.log('✅ Bot siap! Tambahkan ke grup dan ketik !start untuk mulai.');
});

client.on('message', async (msg) => {
  // Abaikan pesan yang dikirim sebelum bot nyala
  if (msg.timestamp < BOT_START_TIME) return;

  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  const groupId    = chat.id._serialized;
  const body       = msg.body.trim();
  const senderId   = msg.author || msg.from;
  const contact    = await msg.getContact();
  const senderName = contact.pushname || contact.number;

  const game = getGame(groupId);

  // ════════════════════════════════════════════════════════════════
  //  COMMANDS
  // ════════════════════════════════════════════════════════════════
  if (body.startsWith('!')) {
    const cmd = body.split(' ')[0].toLowerCase();

    // ── !start ──────────────────────────────────────────────────
    if (cmd === '!start') {
      if (game.phase !== 'idle') {
        await msg.reply('⚠️ Game sudah berjalan atau sedang dalam proses setup!');
        return;
      }
      Object.assign(game, createGame());
      game.phase    = 'setup';
      game.hostId   = senderId;
      game.hostName = senderName;

      await chat.sendMessage(
        `🎮 *Setup Game Sambung Kata*\n` +
        `Host: *${senderName}*\n\n` +
        `Pilih gamemode dengan membalas *2 angka* sekaligus.\nContoh: *1 3*\n\n` +
        `*Pilih Bahasa:*\n` +
        `1️⃣ Bahasa Indonesia (validasi KBBI)\n` +
        `2️⃣ Bahasa Inggris (validasi kamus + terjemahan)\n\n` +
        `*Pilih Timer:*\n` +
        `3️⃣ Timer ON (${TIMER_SECONDS} detik/giliran)\n` +
        `4️⃣ Timer OFF`
      );
      return;
    }

    // ── !stop ───────────────────────────────────────────────────
    if (cmd === '!stop') {
      if (game.phase === 'idle') {
        await msg.reply('⚠️ Tidak ada game yang sedang berjalan.');
        return;
      }
      clearTurnTimer(game);
      if (game.joinTimer) { clearTimeout(game.joinTimer); game.joinTimer = null; }
      game.phase = 'idle';
      await chat.sendMessage(
        `🛑 *Game dihentikan!*\n\nTotal kata: ${game.wordCount}\n\n📊 *Hasil:*\n${formatScoreboard(game.scores)}`
      );
      return;
    }

    // ── !join ───────────────────────────────────────────────────
    if (cmd === '!join') {
      if (game.phase !== 'joining') {
        await msg.reply('⚠️ Tidak ada fase join saat ini.');
        return;
      }
      if (game.joinOrder.find(p => p.id === senderId)) {
        await msg.reply('⚠️ Kamu sudah join!');
        return;
      }
      game.joinOrder.push({ id: senderId, name: senderName });
      game.scores[senderId] = { name: senderName, lives: MAX_LIVES, eliminated: false };
      await msg.reply(`✅ *${senderName}* berhasil join! (posisi ${game.joinOrder.length})`);
      return;
    }



    // ── !lives ──────────────────────────────────────────────────
    if (cmd === '!lives') {
      await chat.sendMessage(`❤️ *Status Nyawa:*\n${formatLives(game.scores)}`);
      return;
    }

    // ── !words ──────────────────────────────────────────────────
    if (cmd === '!words') {
      const prefix = body.split(' ')[1]?.toLowerCase().trim();

      if (!prefix) {
        await msg.reply('⚠️ Masukkan awalan kata. Contoh: *!words a* atau *!words be*');
        return;
      }

      const MAX_SHOW = 10;

      // Kumpulkan semua kata berawalan prefix lalu acak
      const pool = ENGLISH_WORDS_ARR.filter(w => w.startsWith(prefix) && w.length > prefix.length);

      if (pool.length === 0) {
        await msg.reply(`🔍 Tidak ada kata berawalan *"${prefix.toUpperCase()}"* di kamus.`);
        return;
      }

      // Fisher-Yates shuffle, ambil MAX_SHOW pertama
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const results = pool.slice(0, MAX_SHOW);

      const list = results.map((w, i) => {
        const trans = getTranslation(w);
        return `${i + 1}. *${w.toUpperCase()}*${trans ? ` — _${trans}_` : ''}`;
      }).join('\n');

      await msg.reply(`📖 Kata berawalan *"${prefix.toUpperCase()}"*:\n\n${list}`);
      return;
    }

    // ── !level ──────────────────────────────────────────────────
    if (cmd === '!level') {
      if (game.phase !== 'active') { await msg.reply('⚠️ Game belum aktif.'); return; }
      const lvl = getCurrentLevel(game.wordCount, game.loopCount);
      const effectiveLen = game.effectiveSuffixLen ?? lvl.suffixLen;
      await msg.reply(
        `📊 *Status Game*\n${lvl.label} | Kata ke-${game.wordCount} | Loop ke-${game.loopCount}\n` +
        `Kata terakhir: *${game.lastWord ? game.lastWord.toUpperCase() : '-'}*\n` +
        `Sambung dari: *"${game.lastWord ? getSuffix(game.lastWord, effectiveLen).toUpperCase() : '-'}"* (${effectiveLen} huruf)\n\n` +
        `*Syarat naik level:*\n` +
        `• Level 2: 20 kata + 2x loop\n` +
        `• Level 3: 40 kata + 4x loop\n\n` +
        `*Urutan Giliran:*\n${formatTurnOrder(game)}`
      );
      return;
    }

    // ── !reset ──────────────────────────────────────────────────
    if (cmd === '!reset') {
      clearTurnTimer(game);
      if (game.joinTimer) clearTimeout(game.joinTimer);
      games[groupId] = createGame();
      await chat.sendMessage('🔄 Game direset. Ketik !start untuk mulai baru.');
      return;
    }

    // ── !help ───────────────────────────────────────────────────
    if (cmd === '!help') {
      await chat.sendMessage(
        '📖 *Cara Main Sambung Kata*\n\n' +
        '1. *!start* — host mulai setup gamemode\n' +
        '2. Host balas 2 angka pilihan (misal *1 3*)\n' +
        '3. Fase join 10 detik — ketik *!join* untuk ikut\n' +
        '4. Game mulai, giliran berurutan sesuai join\n' +
        '5. Sambung kata sesuai suffix dari kata sebelumnya\n' +
        '6. Salah/timeout → nyawa -1, giliran pindah\n' +
        '7. Habis nyawa → 💀 eliminated\n\n' +
        '*Commands:*\n' +
        '!start • !join • !stop • !lives • !words • !level • !reset • !help'
      );
      return;
    }

    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  SETUP PHASE — host pilih gamemode
  // ════════════════════════════════════════════════════════════════
  if (game.phase === 'setup') {
    if (senderId !== game.hostId) return; // hanya host

    // Expect format: "X Y" where X ∈ {1,2} and Y ∈ {3,4}
    const parts = body.trim().split(/\s+/);
    if (parts.length !== 2) {
      await msg.reply('⚠️ Balas dengan 2 angka sekaligus. Contoh: *1 3* atau *2 4*');
      return;
    }

    const [a, b] = parts.map(Number);
    const langChoice  = [1, 2].includes(a) ? a : [1, 2].includes(b) ? b : null;
    const timerChoice = [3, 4].includes(a) ? a : [3, 4].includes(b) ? b : null;

    if (!langChoice || !timerChoice) {
      await msg.reply(
        '⚠️ Pilihan tidak valid.\n' +
        'Bahasa: *1* (Indonesia) atau *2* (Inggris)\n' +
        'Timer: *3* (ON) atau *4* (OFF)\n' +
        'Contoh: *1 3*'
      );
      return;
    }

    game.lang    = langChoice === 1 ? 'id' : 'en';
    game.timerOn = timerChoice === 3;
    game.phase   = 'joining';

    // Host otomatis join posisi 1
    game.joinOrder.push({ id: game.hostId, name: game.hostName });
    game.scores[game.hostId] = { name: game.hostName, lives: MAX_LIVES, eliminated: false };

    const langLabel  = game.lang === 'id' ? '🇮🇩 Bahasa Indonesia' : '🇬🇧 Bahasa Inggris';
    const timerLabel = game.timerOn ? `⏱️ Timer ON (${TIMER_SECONDS} detik)` : '⏱️ Timer OFF';

    await chat.sendMessage(
      `✅ *Gamemode dipilih!*\n` +
      `${langLabel} | ${timerLabel}\n\n` +
      `⏳ *Fase Join dimulai!*\n` +
      `Ketik *!join* dalam *${JOIN_SECONDS} detik* untuk ikut bermain.\n\n` +
      `✅ ${game.hostName} (host) sudah otomatis join.`
    );

    // Start join countdown
    let remaining = JOIN_SECONDS;
    const countInterval = setInterval(async () => {
      remaining -= 5;
      if (remaining > 0 && remaining <= JOIN_SECONDS) {
        await chat.sendMessage(`⏳ *${remaining} detik lagi* untuk join! Ketik *!join* sekarang.`);
      }
    }, 5000);

    game.joinTimer = setTimeout(async () => {
      clearInterval(countInterval);
      if (game.phase !== 'joining') return;

      if (game.joinOrder.length < 2) {
        game.phase = 'idle';
        await chat.sendMessage(
          '❌ *Game dibatalkan!*\nTidak cukup pemain (minimal 2). Ketik !start untuk coba lagi.'
        );
        return;
      }

      // Start game
      game.phase         = 'active';
      game.currentTurnId = null; // akan di-set saat announceNextTurn pertama

      const langLabel  = game.lang === 'id' ? '🇮🇩 Indonesia' : '🇬🇧 Inggris';
      const timerLabel = game.timerOn ? `⏱️ Timer ${TIMER_SECONDS}s` : '⏱️ No Timer';

      await chat.sendMessage(
        `🚀 *Game dimulai!*\n` +
        `${langLabel} | ${timerLabel}\n\n` +
        `👥 *Urutan Giliran:*\n${formatTurnOrder(game)}\n\n` +
        `📜 *Aturan:*\n` +
        `• Setiap pemain: ${MAX_LIVES} nyawa ❤️\n` +
        `• Salah/timeout → nyawa -1 & giliran pindah`
      );

      // Bot generate kata pertama
      const starterWord = getStarterWord(game.lang);
      game.lastWord = starterWord;
      game.wordCount++;
      game.usedWords.add(starterWord);
      game.lastAcceptedPlayer = { id: 'bot', name: 'Bot' };

      const firstLevel = getCurrentLevel(game.wordCount, game.loopCount);
      const firstResolved = await resolveEffectiveSuffix(starterWord, firstLevel.suffixLen, game.lang);
      game.effectiveSuffixLen = firstResolved.suffixLen;

      await chat.sendMessage(
        `🎲 *Kata pertama dari Bot:* *${starterWord.toUpperCase()}*\n`
      );

      await announceNextTurn(chat, game);
    }, JOIN_SECONDS * 1000);

    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  ACTIVE GAMEPLAY
  // ════════════════════════════════════════════════════════════════
  if (game.phase !== 'active') return;

  // Only registered players
  if (!game.scores[senderId]) {
    await msg.reply('⚠️ Kamu tidak terdaftar di game ini. Tunggu game berikutnya!');
    return;
  }

  const player = game.scores[senderId];
  if (player.eliminated) {
    await msg.reply('💀 Kamu sudah eliminated.');
    return;
  }

  // Only accept single word
  if (/\s/.test(body) || body.length < 2) return;
  const word = body.toLowerCase().replace(/[^a-zA-ZÀ-ÿ]/g, '').toLowerCase();
  if (word.length < 2) return;

  // Must be the current player's turn
  const currentPlayer = getCurrentTurnPlayer(game);
  if (!currentPlayer || senderId !== currentPlayer.id) {
    await msg.reply(`⚠️ Bukan giliran kamu! Sekarang giliran *${currentPlayer?.name ?? '?'}*.`);
    return;
  }

  const level = getCurrentLevel(game.wordCount, game.loopCount);
  const effectiveLen = game.effectiveSuffixLen ?? level.suffixLen;

  // ── Helper: penalize current player & advance turn ──────────────
  async function penalize(reason) {
    clearTurnTimer(game);
    player.lives--;
    const eliminated = player.lives <= 0;
    if (eliminated) player.eliminated = true;

    // Urutan: kill message → nyawa → alasan
    const shooter = game.lastAcceptedPlayer;
    let reply = '';
    if (shooter && shooter.id !== senderId) {
      reply += randomKillMsg(shooter.name, senderName) + '\n';
    }
    reply += `Nyawa tersisa: ${livesBar(Math.max(player.lives, 0))}\n\n`;
    reply += reason;
    if (eliminated) reply += '\n\n💀 *' + senderName + '* habis nyawa dan *eliminated*!';

    // Pick a new (possibly same) suffix from lastWord for the next player
    if (game.lastWord) {
      const level = getCurrentLevel(game.wordCount, game.loopCount);
      const alt = await resolveAlternativeSuffix(game.lastWord, game.effectiveSuffixLen ?? level.suffixLen, game.lang);
      game.suffixOverride = alt;
      reply += `\n\n🔄 Suffix diganti: *"${alt.suffix.toUpperCase()}"* (${alt.suffixLen} huruf) dari *"${game.lastWord.toUpperCase()}"*`;
    }
    
    await msg.reply(reply);

    const active = game.joinOrder.filter(p => !game.scores[p.id]?.eliminated);
    if (active.length <= 1) { await checkGameOver(chat, game); return; }

    advanceTurn(game);
    await announceNextTurn(chat, game, '⏭️ Giliran');
  }

  // ── NORMAL TURN ─────────────────────────────────────────────────
  // Use suffixOverride if set (after wrong answer), otherwise use effectiveSuffixLen
  const activeSuffix = game.suffixOverride
    ? game.suffixOverride.suffix
    : getSuffix(game.lastWord, effectiveLen);
  const activeLen = game.suffixOverride
    ? game.suffixOverride.suffixLen
    : effectiveLen;
  const requiredPrefix = activeSuffix;

  // Word already used — peringatan saja, tidak kurangi nyawa
  if (game.usedWords.has(word)) {
    await msg.reply(`⚠️ Kata *"${word.toUpperCase()}"* sudah pernah dipakai! Coba kata lain.`);
    return;
  }

  // Must start with correct suffix
  if (!word.startsWith(requiredPrefix)) {
    await penalize(
      `❌ Salah! Kata harus dimulai dengan *"${requiredPrefix.toUpperCase()}"* (${activeLen} huruf terakhir dari *"${game.lastWord.toUpperCase()}"*).\nKamu mengirim: *"${word.toUpperCase()}"*`
    );
    return;
  }

  // Must be valid word
  const valid = await validateWord(game, word);
  if (!valid) {
    await penalize(`❌ *"${word}"* tidak ditemukan di kamus.`);
    return;
  }

  // ✅ WORD ACCEPTED
  clearTurnTimer(game);
  game.suffixOverride = null; // clear any override — word accepted normally
  game.lastWord = word;
  game.wordCount++;
  game.usedWords.add(word);
  game.lastAcceptedPlayer = { id: senderId, name: senderName };

  // Track word history (keep last 20)
  game.wordHistory.push({ word, playerName: senderName });
  if (game.wordHistory.length > 20) game.wordHistory.shift();

  const nextLevel = getCurrentLevel(game.wordCount, game.loopCount);
  const resolved  = await resolveEffectiveSuffix(word, nextLevel.suffixLen, game.lang);
  game.effectiveSuffixLen = resolved.suffixLen;

  let reply =
    `✅ *${word.toUpperCase()}* | Kata ke-${game.wordCount}\n`;

  if (game.lang === 'en') {
    const trans = getTranslation(word);
    if (trans) reply += `\n🇮🇩 _${trans}_`;
  }

  if (resolved.note) reply += `\n\n${resolved.note}`;

  await msg.reply(reply);

  advanceTurn(game);
  await announceNextTurn(chat, game);
});

client.initialize();