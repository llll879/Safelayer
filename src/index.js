const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN || TOKEN.includes("PASTE_")) {
  console.error("BOT_TOKEN не указан. Создайте .env на основе .env.example");
  process.exit(1);
}

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => Number(x.trim()))
    .filter(Number.isFinite)
);

const COMPLAINT_CHAT_ID = String(process.env.COMPLAINT_CHAT_ID || "").trim();
const DB_FILE = path.resolve(process.env.DB_FILE || "./data/kmbp.json");
const ASSETS = path.resolve(__dirname, "assets");

const emptyDB = {
  bots: [],
  complaints: [],
  notes: [],
  logs: [],
  users: [],
  checks: [],
  pending: {},
  nextBotId: 1,
  nextComplaintId: 1,
  nextNoteId: 1
};

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(emptyDB, null, 2));
      return clone(emptyDB);
    }
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return { ...clone(emptyDB), ...parsed, pending: parsed.pending || {} };
  } catch (e) {
    console.error("DB read error:", e);
    return clone(emptyDB);
  }
}

let db = loadDB();

function saveDB() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function log(action, userId, details = "") {
  db.logs.push({
    at: new Date().toISOString(),
    action,
    userId: Number(userId) || 0,
    details: String(details).slice(0, 1000)
  });
  if (db.logs.length > 2000) db.logs = db.logs.slice(-2000);
  saveDB();
}

function isAdmin(id) {
  return ADMIN_IDS.has(Number(id));
}

function normalizeUsername(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

function escapeHtml(x) {
  return String(x ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDate(x) {
  if (!x) return "—";
  return new Date(x).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

function publicBotLink(username) {
  return `https://t.me/${normalizeUsername(username)}`;
}

function findBot(username) {
  const n = normalizeUsername(username);
  return db.bots.find(b => b.username === n);
}

function findBotById(id) {
  return db.bots.find(b => b.id === Number(id));
}

function confirmedViolations(b) {
  return db.complaints.filter(c => c.botId === b.id && c.status === "approved");
}

function getReasons(b) {
  return confirmedViolations(b)
    .map(c => String(c.reason || "").trim())
    .filter(Boolean)
    .slice(-5)
    .reverse();
}

function statusLabel(b) {
  if (b.status === "bad") return "ОПАСНЫЙ БОТ";
  if (b.status === "blocked") return "ЗАБЛОКИРОВАН";
  if (b.status === "warning") return "ЕСТЬ ПРЕДУПРЕЖДЕНИЯ";
  if (b.status === "verified") return "ОТЛИЧНЫЙ БОТ";
  return "В БАЗЕ";
}

function statusText(b) {
  if (b.status === "bad") return "❌ Опасный бот — есть подтверждённые нарушения";
  if (b.status === "blocked") return "🚫 Заблокирован в базе";
  if (b.status === "warning") return "⚠️ Есть предупреждения модерации";
  if (b.status === "verified") return "✅ Проверен модерацией и рекомендован";
  return "ℹ️ Зарегистрирован в базе, но ещё не прошёл проверку";
}

function reasonLinesForCard(b) {
  const reasons = getReasons(b);
  if (reasons.length) return reasons;
  if (b.status === "blocked" && b.blockReason) return [b.blockReason];
  return ["Подтверждённых нарушений нет"];
}

function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function svgText(text, x, y, size, fill, weight = 500, anchor = "start") {
  const safe = escapeHtml(text);
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}px" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${safe}</text>`;
}

function findImageMagick() {
  for (const cmd of ["magick", "convert"]) {
    try {
      execFileSync(cmd, ["-version"], { stdio: "ignore" });
      return cmd;
    } catch (_) {}
  }
  return null;
}

const IMAGE_MAGICK = findImageMagick();
const GENERATED_DIR = path.resolve(__dirname, "../data/generated");
fs.mkdirSync(GENERATED_DIR, { recursive: true });

function imTextArgs(args, geometry, text) {
  return [...args, "-annotate", geometry, String(text)];
}

function makeCard(type, b, queriedUsername = "") {
  const file =
    type === "good" ? "good.png" :
    type === "bad" ? "bad.png" :
    "unknown.png";

  const input = path.join(ASSETS, file);
  if (!fs.existsSync(input)) return null;

  // Termux/Android does not reliably support sharp's native runtime.
  // ImageMagick is optional: if it is unavailable, the original template is
  // returned and the same dynamic information is placed in the Telegram caption.
  if (!IMAGE_MAGICK) return fs.readFileSync(input);

  const username = b?.username || normalizeUsername(queriedUsername) || "unknown_bot";
  const telegramId = b?.telegramId ? String(b.telegramId) : "не указан";
  const output = path.join(GENERATED_DIR, `${type}-${crypto.randomUUID()}.png`);

  try {
    let args = [input];

    if (type === "good") {
      // Cover the template's sample title and replace it with the real database name.
      const realName = b?.name || `@${username}`;
      args.push("-fill", "#061006", "-draw", "rectangle 745,245 1450,535");
      args.push("-fill", "#9cff9f", "-font", "DejaVu-Sans", "-pointsize", "25");
      args = imTextArgs(args, "+790+305", "НАЗВАНИЕ БОТА");
      args.push("-fill", "#ffffff", "-pointsize", "42");
      const titleLines = wrapText(realName, 23).slice(0, 2);
      let titleY = 365;
      for (const line of titleLines) {
        args = imTextArgs(args, `+790+${titleY}`, line);
        titleY += 55;
      }
      args.push(
        "-fill", "#071008", "-draw", "rectangle 250,775 800,900",
        "-fill", "#9cff9f", "-font", "DejaVu-Sans", "-pointsize", "25",
      );
      args = imTextArgs(args, "+315+805", "Бот:");
      args.push("-fill", "#ffffff", "-pointsize", "31");
      args = imTextArgs(args, "+315+845", `@${username}`);
      args.push("-fill", "#c9e8ca", "-pointsize", "25");
      args = imTextArgs(args, "+315+878", `ID: ${telegramId}`);
    }

    if (type === "unknown") {
      args.push(
        "-fill", "#080711", "-draw", "rectangle 270,760 770,885",
        "-fill", "#caa7ff", "-font", "DejaVu-Sans", "-pointsize", "25",
      );
      args = imTextArgs(args, "+315+805", "Бот:");
      args.push("-fill", "#ffffff", "-pointsize", "31");
      args = imTextArgs(args, "+315+845", `@${username}`);
      args.push("-fill", "#bca8d8", "-pointsize", "25");
      args = imTextArgs(args, "+315+878", "ID: не найден");
      args.push("-fill", "#080711", "-draw", "rectangle 750,545 1345,845");
      args.push("-fill", "#d7b8ff", "-pointsize", "30");
      args = imTextArgs(args, "+790+600", "Проверка");
      args.push("-fill", "#ffffff", "-pointsize", "26");
      args = imTextArgs(args, "+790+650", "Бот отсутствует в базе");
      args.push("-fill", "#d5c8e8", "-pointsize", "24");
      args = imTextArgs(args, "+790+705", "Информация не подтверждена");
      args = imTextArgs(args, "+790+755", "Нельзя считать бот безопасным");
      args = imTextArgs(args, "+790+805", "Рекомендуется проверить вручную");
    }

    if (type === "bad") {
      const reasons = reasonLinesForCard(b);
      // Cover the template's sample title and replace it with the real database name.
      const realName = b?.name || `@${username}`;
      args.push("-fill", "#0b030b", "-draw", "rectangle 690,270 1450,535");
      args.push("-fill", "#ff77ba", "-font", "DejaVu-Sans", "-pointsize", "25");
      args = imTextArgs(args, "+735+325", "НАЗВАНИЕ БОТА");
      args.push("-fill", "#ffffff", "-pointsize", "42");
      const titleLines = wrapText(realName, 24).slice(0, 2);
      let titleY = 390;
      for (const line of titleLines) {
        args = imTextArgs(args, `+735+${titleY}`, line);
        titleY += 55;
      }
      args.push("-fill", "#0b030b", "-draw", "rectangle 730,555 1340,885");
      args.push("-fill", "#ff77ba", "-font", "DejaVu-Sans", "-pointsize", "29");
      args = imTextArgs(args, "+775+610", "Подтверждённые причины");
      let y = 660;
      for (const reason of reasons.slice(0, 5)) {
        const lines = wrapText(reason, 32).slice(0, 2);
        args.push("-fill", "#ff3d91", "-pointsize", "24");
        args = imTextArgs(args, `+775+${y}`, "×");
        args.push("-fill", "#ffffff", "-pointsize", "22");
        args = imTextArgs(args, `+825+${y}`, lines[0]);
        if (lines[1]) args = imTextArgs(args, `+825+${y + 28}`, lines[1]);
        y += lines.length > 1 ? 68 : 55;
        if (y > 850) break;
      }
      args.push("-fill", "#0b030b", "-draw", "rectangle 170,760 770,885");
      args.push("-fill", "#ff77ba", "-pointsize", "25");
      args = imTextArgs(args, "+215+805", "Бот:");
      args.push("-fill", "#ffffff", "-pointsize", "31");
      args = imTextArgs(args, "+215+845", `@${username}`);
      args.push("-fill", "#f2c5dd", "-pointsize", "25");
      args = imTextArgs(args, "+215+878", `ID: ${telegramId}`);
    }

    args.push("-strip", output);
    execFileSync(IMAGE_MAGICK, args, { stdio: "ignore", timeout: 30000 });
    const buffer = fs.readFileSync(output);
    fs.rmSync(output, { force: true });
    return buffer;
  } catch (e) {
    console.error("Card generation fallback:", e.message);
    fs.rmSync(output, { force: true });
    return fs.readFileSync(input);
  }
}

function botTextCard(b, admin = false) {
  const violations = confirmedViolations(b);
  let s = `🤖 <b>${escapeHtml(b.name || "Без названия")}</b>\n`;
  s += `🔗 @${escapeHtml(b.username)}\n`;
  s += `${statusText(b)}\n\n`;
  s += `📝 ${escapeHtml(b.description || "Описание не указано")}\n`;
  s += `📌 В базе с: ${formatDate(b.createdAt)}\n`;
  s += `📨 Жалоб: ${db.complaints.filter(c => c.botId === b.id).length}\n`;

  if (violations.length) {
    s += `\n🚩 <b>Подтверждённые причины:</b>\n`;
    getReasons(b).forEach((reason, i) => {
      s += `${i + 1}. ${escapeHtml(reason)}\n`;
    });
  }

  if (b.stats && Object.keys(b.stats).length) {
    s += `\n📊 <b>Статистика проекта</b>\n`;
    for (const [k, v] of Object.entries(b.stats)) {
      s += `• ${escapeHtml(k)}: ${escapeHtml(String(v))}\n`;
    }
  }

  if (admin && b.ownerId) s += `\n👤 Владелец ID: <code>${b.ownerId}</code>\n`;
  if (admin && b.telegramId) s += `🆔 Telegram ID бота: <code>${escapeHtml(b.telegramId)}</code>\n`;
  return s;
}

function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔎 Проверить бота", callback_data: "menu:check" },
        { text: "🔍 Поиск", callback_data: "menu:search" }
      ],
      [
        { text: "📝 Зарегистрировать", callback_data: "menu:register" },
        { text: "🚨 Пожаловаться", callback_data: "menu:report" }
      ],
      [
        { text: "📊 Статистика", callback_data: "menu:stats" },
        { text: "❓ Помощь", callback_data: "menu:help" }
      ]
    ]
  };
}

function helpText(admin = false) {
  const adminBlock = admin ? `\n\nАдминистратор:\n🛡 <code>/admin</code>\n➕ <code>/addbot @bot Название | описание</code>\n✅ <code>/verify @bot</code>\n🆔 <code>/setid @bot 123456789</code>\n⚠️ <code>/warnbot @bot причина</code>\n🚫 <code>/banbot @bot причина</code>\n🔓 <code>/unbanbot @bot</code>\n🚩 <code>/reason @bot текст</code>\n📝 <code>/botnote @bot текст</code>\n📊 <code>/setstats @bot users=100,active=20</code>\n📜 <code>/logs</code>` : "";
  return `<b>🛡 КМБП Base</b>

🔎 <code>/check @bot</code> — проверить бота
🔍 <code>/search запрос</code> — найти в базе
📝 <code>/register</code> — зарегистрировать проект
🚨 <code>/report @bot причина</code> — отправить жалобу
📊 <code>/stats</code> — статистика
🏆 <code>/top</code> — лучшие проекты
🕘 <code>/recent</code> — последние добавления
❌ <code>/cancel</code> — отменить текущий ввод

${adminBlock}

<i>Плохой статус появляется только после подтверждения модератором.</i>`;
}

async function sendResult(chatId, b, queriedUsername) {
  if (!b) {
    const photo = await makeCard("unknown", null, queriedUsername);
    if (photo) {
      return bot.sendPhoto(chatId, photo, {
        caption: `🔎 <b>${escapeHtml("@" + normalizeUsername(queriedUsername))}</b>\n\nБота нет в базе КМБП.\nИнформация о нём не подтверждена. Это не означает, что бот опасен — просто в базе пока нет записи.`,
        parse_mode: "HTML"
      });
    }
    return bot.sendMessage(chatId,
      `🔎 <b>@${escapeHtml(normalizeUsername(queriedUsername))}</b>\n\nБота нет в базе КМБП.\nИнформация о нём не подтверждена.`,
      { parse_mode: "HTML" }
    );
  }

  db.checks.push({
    at: new Date().toISOString(),
    botId: b.id,
    username: b.username
  });
  if (db.checks.length > 5000) db.checks = db.checks.slice(-5000);
  saveDB();

  const type = b.status === "bad" || b.status === "blocked" ? "bad" :
    b.status === "verified" ? "good" : null;

  const photo = type ? await makeCard(type, b) : null;
  const keyboard = {
    inline_keyboard: [
      [{ text: "🤖 Открыть бота", url: publicBotLink(b.username) }],
      [
        { text: "🚨 Пожаловаться", callback_data: `report:${b.id}` },
        { text: "🔄 Обновить", callback_data: `refresh:${b.id}` }
      ]
    ]
  };

  const caption = botTextCard(b);
  if (photo) {
    return bot.sendPhoto(chatId, photo, {
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  }

  return bot.sendMessage(chatId, caption, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
}

async function createComplaint(msg, username, reason) {
  if (COMPLAINT_CHAT_ID && String(msg.chat.id) !== COMPLAINT_CHAT_ID) {
    return bot.sendMessage(msg.chat.id, "🚨 Жалобы принимаются только в специальном чате КМБП.");
  }

  const b = findBot(username);
  if (!b) {
    return bot.sendMessage(msg.chat.id,
      `🔎 @${escapeHtml(normalizeUsername(username))} нет в базе. Сначала зарегистрируйте/добавьте бота.`,
      { parse_mode: "HTML" }
    );
  }

  if (!reason || reason.trim().length < 5) {
    return bot.sendMessage(msg.chat.id, "Укажите подробную причину жалобы.");
  }

  const c = {
    id: db.nextComplaintId++,
    botId: b.id,
    username: b.username,
    reporterId: msg.from.id,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    reason: reason.trim().slice(0, 1500),
    status: "pending",
    createdAt: new Date().toISOString()
  };

  db.complaints.push(c);
  saveDB();
  log("report", msg.from.id, `#${c.id} @${b.username}`);

  await bot.sendMessage(msg.chat.id,
    `🚨 Жалоба №${c.id} зарегистрирована и передана модераторам.`,
    { reply_to_message_id: msg.message_id }
  ).catch(() => {});

  const adminText = `🚨 <b>Новая жалоба №${c.id}</b>

🤖 Бот: @${escapeHtml(b.username)}
📝 Причина: ${escapeHtml(c.reason)}
📅 ${formatDate(c.createdAt)}`;

  for (const adminId of ADMIN_IDS) {
    await bot.sendMessage(adminId, adminText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Подтвердить", callback_data: `approve:${c.id}` },
          { text: "❌ Отклонить", callback_data: `reject:${c.id}` }
        ]]
      }
    }).catch(e => console.error("Admin notification:", e.message));
  }
}

async function startRegistration(msg) {
  db.pending[msg.from.id] = { type: "register", step: "username" };
  saveDB();
  return bot.sendMessage(msg.chat.id,
    "📝 Регистрация бота.\n\n1/3 Пришлите @username бота.",
    { parse_mode: "HTML" }
  );
}

async function processPending(msg) {
  const p = db.pending[msg.from?.id];
  if (!p || !msg.text || msg.text.startsWith("/")) return false;

  if (p.type === "check") {
    delete db.pending[msg.from.id];
    saveDB();
    await sendResult(msg.chat.id, findBot(msg.text), msg.text);
    return true;
  }

  if (p.type === "search") {
    delete db.pending[msg.from.id];
    saveDB();
    const q = msg.text.toLowerCase().replace(/^@/, "").trim();
    const results = db.bots.filter(b =>
      b.username.includes(q) || String(b.name || "").toLowerCase().includes(q)
    ).slice(0, 10);
    if (!results.length) {
      await bot.sendMessage(msg.chat.id, "🔍 Ничего не найдено.");
      return true;
    }
    const text = results.map((b, i) =>
      `${i + 1}. <b>${escapeHtml(b.name || b.username)}</b> — @${escapeHtml(b.username)}\n${statusText(b)}`
    ).join("\n\n");
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    return true;
  }

  if (p.type === "report") {
    const b = findBot(p.username);
    delete db.pending[msg.from.id];
    saveDB();
    await createComplaint(msg, p.username, msg.text);
    return true;
  }

  if (p.type === "register") {
    if (p.step === "username") {
      const username = normalizeUsername(msg.text);
      if (!/^[a-z0-9_]{5,32}$/i.test(username)) {
        await bot.sendMessage(msg.chat.id, "❌ Некорректный username. Пришлите @username Telegram-бота.");
        return true;
      }
      p.username = username;
      p.step = "name";
      saveDB();
      await bot.sendMessage(msg.chat.id, "2/3 Напишите название проекта.");
      return true;
    }

    if (p.step === "name") {
      p.name = msg.text.trim().slice(0, 100);
      p.step = "description";
      saveDB();
      await bot.sendMessage(msg.chat.id, "3/3 Напишите короткое описание.");
      return true;
    }

    if (p.step === "description") {
      const username = p.username;
      let b = findBot(username);
      if (!b) {
        b = {
          id: db.nextBotId++,
          username,
          name: p.name,
          description: msg.text.trim().slice(0, 500),
          ownerId: msg.from.id,
          status: "active",
          createdAt: new Date().toISOString(),
          stats: {}
        };
        db.bots.push(b);
      } else {
        b.name = p.name;
        b.description = msg.text.trim().slice(0, 500);
        b.ownerId ||= msg.from.id;
      }

      delete db.pending[msg.from.id];
      saveDB();
      log("register", msg.from.id, `@${username}`);

      await bot.sendMessage(msg.chat.id,
        `✅ <b>Проект зарегистрирован.</b>\n\n${botTextCard(b)}`,
        { parse_mode: "HTML" }
      );
      return true;
    }
  }

  return false;
}

const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 500,
    autoStart: true,
    params: { timeout: 30 }
  }
});

bot.on("polling_error", err => {
  console.error("Telegram polling error:", err?.response?.body || err.message);
  if (String(err.message).includes("409")) {
    console.error("ОШИБКА 409: этот токен уже используется другим запущенным экземпляром бота.");
  }
});

bot.on("error", err => console.error("Telegram bot error:", err.message));

bot.onText(/^\/start(?:@\w+)?$/i, async msg => {
  try {
    await processPending(msg);
    await bot.sendMessage(msg.chat.id,
      `👋 <b>КМБП Base</b>\n\nПроверяйте Telegram-ботов, смотрите подтверждённые нарушения и отправляйте жалобы модераторам.\n\nВыберите действие:`,
      { parse_mode: "HTML", reply_markup: menuKeyboard() }
    );
  } catch (e) {
    console.error("/start:", e);
  }
});

bot.onText(/^\/help(?:@\w+)?$/i, msg => bot.sendMessage(msg.chat.id, helpText(isAdmin(msg.from.id)), { parse_mode: "HTML" }).catch(console.error));

bot.onText(/^\/check(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  try {
    if (match[1]) return await sendResult(msg.chat.id, findBot(match[1]), match[1]);
    db.pending[msg.from.id] = { type: "check" };
    saveDB();
    await bot.sendMessage(msg.chat.id, "🔎 Пришлите @username бота, которого хотите проверить.");
  } catch (e) {
    console.error("/check:", e);
  }
});

bot.onText(/^\/search(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  try {
    if (match[1]) {
      const q = match[1].toLowerCase().replace(/^@/, "");
      const results = db.bots.filter(b => b.username.includes(q) || String(b.name || "").toLowerCase().includes(q)).slice(0, 10);
      if (!results.length) return bot.sendMessage(msg.chat.id, "🔍 Ничего не найдено.");
      return bot.sendMessage(msg.chat.id,
        results.map((b, i) => `${i + 1}. <b>${escapeHtml(b.name || b.username)}</b> — @${escapeHtml(b.username)}\n${statusText(b)}`).join("\n\n"),
        { parse_mode: "HTML" }
      );
    }
    db.pending[msg.from.id] = { type: "search" };
    saveDB();
    await bot.sendMessage(msg.chat.id, "🔍 Пришлите название или @username для поиска.");
  } catch (e) {
    console.error("/search:", e);
  }
});

bot.onText(/^\/stats(?:@\w+)?$/i, async msg => {
  const total = db.bots.length;
  const verified = db.bots.filter(b => b.status === "verified").length;
  const bad = db.bots.filter(b => b.status === "bad" || b.status === "blocked").length;
  const complaints = db.complaints.length;
  const approved = db.complaints.filter(c => c.status === "approved").length;
  await bot.sendMessage(msg.chat.id,
    `📊 <b>Статистика КМБП</b>\n\n🤖 Ботов: <b>${total}</b>\n✅ Проверено: <b>${verified}</b>\n❌ Опасных/заблокированных: <b>${bad}</b>\n🚨 Жалоб: <b>${complaints}</b>\n🚩 Подтверждённых нарушений: <b>${approved}</b>\n🔎 Проверок: <b>${db.checks.length}</b>\n👥 Пользователей: <b>${db.users.length}</b>`,
    { parse_mode: "HTML" }
  ).catch(console.error);
});

bot.onText(/^\/top(?:@\w+)?$/i, msg => {
  const list = db.bots.filter(b => b.status === "verified").slice(-10).reverse();
  const text = list.length
    ? list.map((b, i) => `${i + 1}. <b>${escapeHtml(b.name || b.username)}</b> — @${escapeHtml(b.username)}`).join("\n")
    : "Пока нет ботов, которых модерация отметила как проверенных.";
  bot.sendMessage(msg.chat.id, `🏆 <b>Рекомендованные проекты</b>\n\n${text}`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/recent(?:@\w+)?$/i, msg => {
  const list = db.bots.slice(-10).reverse();
  const text = list.length
    ? list.map((b, i) => `${i + 1}. @${escapeHtml(b.username)} — ${escapeHtml(statusLabel(b))}`).join("\n")
    : "База пока пустая.";
  bot.sendMessage(msg.chat.id, `🕘 <b>Последние добавления</b>\n\n${text}`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/register(?:@\w+)?$/i, msg => startRegistration(msg).catch(console.error));

bot.onText(/^\/report(?:@\w+)?(?:\s+(\S+)\s+([\s\S]+))?$/i, async (msg, match) => {
  try {
    if (match[1] && match[2]) return await createComplaint(msg, match[1], match[2]);
    db.pending[msg.from.id] = { type: "report", username: "" };
    saveDB();
    await bot.sendMessage(msg.chat.id, "🚨 Пришлите @username бота, на который хотите пожаловаться.");
    db.pending[msg.from.id].step = "username";
    saveDB();
  } catch (e) {
    console.error("/report:", e);
  }
});

bot.onText(/^\/cancel(?:@\w+)?$/i, msg => {
  delete db.pending[msg.from.id];
  saveDB();
  bot.sendMessage(msg.chat.id, "❌ Текущий ввод отменён.");
});

bot.onText(/^\/admin(?:@\w+)?$/i, msg => {
  if (!isAdmin(msg.from.id)) return;
  const pending = db.complaints.filter(c => c.status === "pending").length;
  bot.sendMessage(msg.chat.id,
    `<b>🛡 КМБП Admin</b>\n\n🤖 Ботов: ${db.bots.length}\n🚨 Жалоб на рассмотрении: ${pending}\n🔎 Проверок: ${db.checks.length}\n\nКоманды:\n/addbot @bot Название | описание\n/verify @bot\n/setid @bot 123456789\n/warnbot @bot причина\n/banbot @bot причина\n/unbanbot @bot\n/reason @bot текст\n/botnote @bot текст\n/setstats @bot users=100,active=20\n/logs`,
    { parse_mode: "HTML" }
  ).catch(console.error);
});

bot.onText(/^\/addbot(?:@\w+)?\s+(\S+)\s+(.+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const username = normalizeUsername(match[1]);
  const parts = match[2].split("|").map(x => x.trim());
  let b = findBot(username);
  if (!b) {
    b = {
      id: db.nextBotId++,
      username,
      name: parts[0] || username,
      description: parts[1] || "",
      ownerId: null,
      status: "active",
      createdAt: new Date().toISOString(),
      stats: {}
    };
    db.bots.push(b);
  } else {
    b.name = parts[0] || b.name;
    b.description = parts[1] || b.description;
  }
  saveDB();
  log("addbot", msg.from.id, `@${username}`);
  bot.sendMessage(msg.chat.id, `✅ @${escapeHtml(username)} добавлен/обновлён.`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/verify(?:@\w+)?\s+(\S+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const b = findBot(match[1]);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  b.status = "verified";
  b.verifiedAt = new Date().toISOString();
  saveDB();
  log("verify", msg.from.id, `@${b.username}`);
  bot.sendMessage(msg.chat.id, `✅ @${escapeHtml(b.username)} отмечен как проверенный.`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/setid(?:@\w+)?\s+(\S+)\s+(\d+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const b = findBot(match[1]);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  b.telegramId = match[2];
  saveDB();
  log("setid", msg.from.id, `@${b.username}`);
  bot.sendMessage(msg.chat.id, `🆔 ID @${escapeHtml(b.username)} сохранён: <code>${escapeHtml(match[2])}</code>`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/warnbot(?:@\w+)?\s+(\S+)\s+(.+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const b = findBot(match[1]);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  b.status = "warning";
  b.warningReason = match[2].trim().slice(0, 500);
  saveDB();
  log("warnbot", msg.from.id, `@${b.username}: ${b.warningReason}`);
  bot.sendMessage(msg.chat.id, `⚠️ @${escapeHtml(b.username)} получил предупреждение.`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/banbot(?:@\w+)?\s*(.*)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const args = match[1].trim().split(/\s+/);
  const username = args.shift();
  if (!username) return bot.sendMessage(msg.chat.id, "Использование: /banbot @bot причина");
  const b = findBot(username);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  b.status = "blocked";
  b.blockReason = args.join(" ") || "Решение модератора";
  b.blockedAt = new Date().toISOString();
  saveDB();
  log("banbot", msg.from.id, `@${b.username}: ${b.blockReason}`);
  bot.sendMessage(msg.chat.id, `🚫 @${escapeHtml(b.username)} заблокирован в базе.`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/unbanbot(?:@\w+)?\s+(\S+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const b = findBot(match[1]);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  b.status = confirmedViolations(b).length ? "bad" : "active";
  delete b.blockReason;
  saveDB();
  log("unbanbot", msg.from.id, `@${b.username}`);
  bot.sendMessage(msg.chat.id, `🔓 Статус @${escapeHtml(b.username)} обновлён.`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/reason(?:@\w+)?\s+(\S+)\s+(.+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const b = findBot(match[1]);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  db.complaints.push({
    id: db.nextComplaintId++,
    botId: b.id,
    username: b.username,
    reporterId: msg.from.id,
    reason: match[2].trim().slice(0, 1500),
    status: "approved",
    createdAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    reviewedBy: msg.from.id,
    source: "admin"
  });
  b.status = "bad";
  saveDB();
  log("reason", msg.from.id, `@${b.username}: ${match[2]}`);
  bot.sendMessage(msg.chat.id, `🚩 Причина добавлена к @${escapeHtml(b.username)} и подтверждена.`, { parse_mode: "HTML" }).catch(console.error);
});

bot.onText(/^\/botnote(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const b = findBot(match[1]);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  db.notes.push({ id: db.nextNoteId++, botId: b.id, authorId: msg.from.id, text: match[2], at: new Date().toISOString() });
  saveDB();
  log("botnote", msg.from.id, `@${b.username}`);
  bot.sendMessage(msg.chat.id, "📝 Заметка сохранена.").catch(console.error);
});

bot.onText(/^\/setstats(?:@\w+)?\s+(\S+)\s+(.+)$/i, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const b = findBot(match[1]);
  if (!b) return bot.sendMessage(msg.chat.id, "❌ Бот не найден.");
  b.stats = {};
  for (const item of match[2].split(",")) {
    const i = item.indexOf("=");
    if (i > 0) b.stats[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  saveDB();
  log("setstats", msg.from.id, `@${b.username}`);
  bot.sendMessage(msg.chat.id, "📊 Статистика обновлена.").catch(console.error);
});

bot.onText(/^\/logs(?:@\w+)?$/i, msg => {
  if (!isAdmin(msg.from.id)) return;
  const lines = db.logs.slice(-30).reverse().map(x =>
    `${formatDate(x.at)} — ${escapeHtml(x.action)} — <code>${x.userId}</code> — ${escapeHtml(x.details)}`
  ).join("\n");
  bot.sendMessage(msg.chat.id, `<b>📜 Последние действия</b>\n\n${lines || "Пусто"}`, { parse_mode: "HTML" }).catch(console.error);
});

bot.on("callback_query", async q => {
  try {
    const uid = q.from.id;
    const data = q.data || "";

    if (data.startsWith("menu:")) {
      const action = data.split(":")[1];
      await bot.answerCallbackQuery(q.id).catch(() => {});

      if (action === "check") {
        db.pending[uid] = { type: "check" };
        saveDB();
        return bot.sendMessage(q.message.chat.id, "🔎 Пришлите @username бота.");
      }
      if (action === "search") {
        db.pending[uid] = { type: "search" };
        saveDB();
        return bot.sendMessage(q.message.chat.id, "🔍 Пришлите название или @username.");
      }
      if (action === "register") return startRegistration({ from: q.from, chat: q.message.chat });
      if (action === "report") {
        db.pending[uid] = { type: "report", step: "username" };
        saveDB();
        return bot.sendMessage(q.message.chat.id, "🚨 Пришлите @username бота.");
      }
      if (action === "stats") {
        const total = db.bots.length;
        const bad = db.bots.filter(b => b.status === "bad" || b.status === "blocked").length;
        return bot.sendMessage(q.message.chat.id, `📊 Ботов: ${total}\n❌ Опасных/заблокированных: ${bad}\n🚨 Жалоб: ${db.complaints.length}`);
      }
      if (action === "help") return bot.sendMessage(q.message.chat.id, helpText(isAdmin(uid)), { parse_mode: "HTML" });
    }

    if (data.startsWith("refresh:")) {
      const b = findBotById(data.split(":")[1]);
      await bot.answerCallbackQuery(q.id, { text: b ? "Обновлено" : "Бот не найден" }).catch(() => {});
      return sendResult(q.message.chat.id, b, b?.username || "");
    }

    if (data.startsWith("report:")) {
      const b = findBotById(data.split(":")[1]);
      if (!b) return bot.answerCallbackQuery(q.id, { text: "Бот не найден", show_alert: true });
      db.pending[uid] = { type: "report", step: "reason", username: b.username };
      saveDB();
      await bot.answerCallbackQuery(q.id).catch(() => {});
      return bot.sendMessage(q.message.chat.id, `🚨 Напишите причину жалобы на @${escapeHtml(b.username)}.`, { parse_mode: "HTML" });
    }

    if (data.startsWith("approve:") || data.startsWith("reject:")) {
      if (!isAdmin(uid)) return bot.answerCallbackQuery(q.id, { text: "Нет доступа", show_alert: true });
      const [action, idStr] = data.split(":");
      const c = db.complaints.find(x => x.id === Number(idStr));
      if (!c) return bot.answerCallbackQuery(q.id, { text: "Жалоба не найдена", show_alert: true });
      if (c.status !== "pending") return bot.answerCallbackQuery(q.id, { text: "Уже обработано" });

      c.status = action === "approve" ? "approved" : "rejected";
      c.reviewedBy = uid;
      c.reviewedAt = new Date().toISOString();

      const b = findBotById(c.botId);
      if (b && c.status === "approved") b.status = "bad";
      if (b && c.status === "rejected" && !confirmedViolations(b).length && b.status === "bad") b.status = "active";

      saveDB();
      log(c.status === "approved" ? "approve" : "reject", uid, `#${c.id}`);

      await bot.answerCallbackQuery(q.id, {
        text: c.status === "approved" ? "Нарушение подтверждено" : "Жалоба отклонена"
      }).catch(() => {});

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id
      }).catch(() => {});

      return bot.sendMessage(q.message.chat.id,
        c.status === "approved"
          ? `🚩 Жалоба №${c.id} подтверждена. @${escapeHtml(c.username)} получил статус опасного бота.`
          : `❌ Жалоба №${c.id} отклонена.`,
        { parse_mode: "HTML" }
      );
    }
  } catch (e) {
    console.error("callback error:", e);
  }
});

bot.on("message", async msg => {
  try {
    if (msg.from) {
      const existing = db.users.find(u => u.id === msg.from.id);
      if (existing) {
        existing.username = msg.from.username || "";
        existing.lastSeen = new Date().toISOString();
      } else {
        db.users.push({
          id: msg.from.id,
          username: msg.from.username || "",
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString()
        });
      }
      saveDB();
    }

    if (msg.text && msg.text.startsWith("/")) {
      // Commands are handled by onText handlers.
      return;
    }

    const p = db.pending[msg.from?.id];
    if (!p) return;

    if (p.type === "report" && p.step === "username") {
      const username = normalizeUsername(msg.text);
      if (!findBot(username)) {
        delete db.pending[msg.from.id];
        saveDB();
        return bot.sendMessage(msg.chat.id, "❌ Бот не найден в базе. Жалоба не создана.");
      }
      p.username = username;
      p.step = "reason";
      saveDB();
      return bot.sendMessage(msg.chat.id, `🚨 Теперь опишите нарушение для @${escapeHtml(username)}.`, { parse_mode: "HTML" });
    }

    await processPending(msg);
  } catch (e) {
    console.error("message handler:", e);
  }
});

bot.getMe()
  .then(me => {
    console.log(`KMBP Base запущен как @${me.username} (ID ${me.id})`);
    console.log(`Администраторов: ${[...ADMIN_IDS].join(", ") || "не настроены"}`);
  })
  .catch(e => {
    console.error("Не удалось выполнить getMe(). Проверьте BOT_TOKEN:", e.message);
  });
