import asyncio
import logging
import os
import sqlite3
from datetime import datetime, timezone
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message, CallbackQuery
from aiogram.utils.keyboard import InlineKeyboardBuilder, ReplyKeyboardBuilder

load_dotenv()
TOKEN = os.getenv("BOT_TOKEN", "")
DB_PATH = os.getenv("DB_PATH", "safelayer.db")
ADMIN_IDS = {int(x.strip()) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()}

if not TOKEN:
    raise RuntimeError("BOT_TOKEN is not configured")

logging.basicConfig(level=logging.INFO)
bot = Bot(TOKEN)
dp = Dispatcher()

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row

def init_db():
    db.executescript("""
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      blocked INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sellers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      sl_id TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      username TEXT,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '',
      verified INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS reviews(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      text TEXT NOT NULL,
      verified_deal INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      seller_reply TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(seller_id, author_id),
      FOREIGN KEY(seller_id) REFERENCES sellers(id),
      FOREIGN KEY(author_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS reports(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TEXT NOT NULL,
      UNIQUE(review_id, reporter_id),
      FOREIGN KEY(review_id) REFERENCES reviews(id),
      FOREIGN KEY(reporter_id) REFERENCES users(id)
    );
    """)
    db.commit()

def ensure_user(tg):
    db.execute("""INSERT INTO users(id,username,first_name,created_at)
                  VALUES(?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name""",
               (tg.id, tg.username, tg.first_name or "", now()))
    db.commit()

def is_blocked(uid):
    r = db.execute("SELECT blocked FROM users WHERE id=?", (uid,)).fetchone()
    return bool(r and r["blocked"])

def get_seller(s):
    s = s.strip()
    if s.startswith("@"): s = s[1:]
    row = db.execute("""SELECT * FROM sellers WHERE sl_id=? OR lower(username)=lower(?) OR lower(display_name)=lower(?)""",
                     (s.upper(), s, s)).fetchone()
    return row

def rating_info(seller_id):
    r = db.execute("""SELECT COUNT(*) c, COALESCE(AVG(rating),0) avg,
                      SUM(CASE WHEN rating>=4 THEN 1 ELSE 0 END) pos,
                      SUM(CASE WHEN rating=3 THEN 1 ELSE 0 END) neu,
                      SUM(CASE WHEN rating<=2 THEN 1 ELSE 0 END) neg
                      FROM reviews WHERE seller_id=? AND status='approved'""",(seller_id,)).fetchone()
    return r

def seller_card(row):
    ri = rating_info(row["id"])
    rating = float(ri["avg"] or 0)
    stars = "⭐" * round(rating) if ri["c"] else "—"
    verified = " ✅" if row["verified"] else ""
    return (f"🏪 <b>{row['display_name']}</b>{verified}\n"
            f"🆔 <code>{row['sl_id']}</code>\n"
            f"👤 @{row['username'] or 'не указан'}\n"
            f"⭐ Рейтинг: <b>{rating:.1f}/5</b> {stars}\n"
            f"📝 Отзывов: <b>{ri['c']}</b>\n"
            f"🟢 Положительных: {ri['pos'] or 0}\n"
            f"🟡 Нейтральных: {ri['neu'] or 0}\n"
            f"🔴 Отрицательных: {ri['neg'] or 0}\n"
            f"📁 Категория: {row['category'] or 'не указана'}\n"
            f"ℹ️ {row['description'] or 'Описание отсутствует.'}")

def main_kb():
    kb = ReplyKeyboardBuilder()
    for text in ["🔎 Проверить продавца", "✍️ Оставить отзыв"]:
        kb.button(text=text)
    for text in ["🏪 Стать продавцом", "👤 Мой профиль"]:
        kb.button(text=text)
    for text in ["📊 Моя репутация", "⚠️ Мои жалобы"]:
        kb.button(text=text)
    kb.adjust(2)
    return kb.as_markup(resize_keyboard=True)

class SearchState(StatesGroup):
    query = State()

class ReviewState(StatesGroup):
    seller = State()
    rating = State()
    text = State()
    verified = State()

class SellerState(StatesGroup):
    name = State()
    category = State()
    description = State()

class ReplyState(StatesGroup):
    review_id = State()
    text = State()

class ReportState(StatesGroup):
    review_id = State()
    reason = State()

@dp.message(CommandStart())
async def start(m: Message, state: FSMContext):
    ensure_user(m.from_user)
    await state.clear()
    if is_blocked(m.from_user.id):
        return await m.answer("🚫 Ваш аккаунт заблокирован.")
    await m.answer(
        "🛡️ <b>SafeLayer</b>\n\n"
        "Проверяйте репутацию продавцов перед сделкой и оставляйте честные отзывы после покупки.\n\n"
        "Выберите действие:", reply_markup=main_kb())

@dp.message(F.text == "🔎 Проверить продавца")
async def search_start(m: Message, state: FSMContext):
    await state.set_state(SearchState.query)
    await m.answer("Введите @username, SafeLayer ID или название продавца:")

@dp.message(SearchState.query)
async def search_do(m: Message, state: FSMContext):
    row = get_seller(m.text)
    await state.clear()
    if not row:
        return await m.answer("❌ Продавец не найден.")
    b = InlineKeyboardBuilder()
    b.button(text="📝 Отзывы", callback_data=f"reviews:{row['id']}")
    b.button(text="✍️ Оставить отзыв", callback_data=f"newreview:{row['id']}")
    await m.answer(seller_card(row), reply_markup=b.as_markup())

@dp.callback_query(F.data.startswith("reviews:"))
async def reviews(c: CallbackQuery):
    sid = int(c.data.split(":")[1])
    row = db.execute("SELECT * FROM sellers WHERE id=?", (sid,)).fetchone()
    if not row: return await c.answer("Не найдено", show_alert=True)
    rs = db.execute("""SELECT r.*, u.username FROM reviews r JOIN users u ON u.id=r.author_id
                       WHERE r.seller_id=? AND r.status='approved' ORDER BY r.created_at DESC LIMIT 30""",(sid,)).fetchall()
    if not rs:
        return await c.message.answer("📝 У продавца пока нет опубликованных отзывов.")
    for r in rs:
        mark = "🔹" if r["rating"]==3 else ("🟢" if r["rating"]>=4 else "🔴")
        reply = f"\n↩️ <b>Ответ продавца:</b> {r['seller_reply']}" if r["seller_reply"] else ""
        b = InlineKeyboardBuilder()
        b.button(text="⚠️ Пожаловаться", callback_data=f"report:{r['id']}")
        if c.from_user.id == row["user_id"]:
            b.button(text="↩️ Ответить", callback_data=f"reply:{r['id']}")
        await c.message.answer(
            f"{mark} <b>{r['rating']}/5</b> — @{r['username'] or 'пользователь'}\n"
            f"{r['text']}\n📅 {r['created_at'][:10]}{reply}",
            reply_markup=b.as_markup())

@dp.callback_query(F.data.startswith("newreview:"))
async def review_start_cb(c: CallbackQuery, state: FSMContext):
    await state.update_data(seller_id=int(c.data.split(":")[1]))
    await state.set_state(ReviewState.rating)
    await c.message.answer("Оценка от 1 до 5:")
    await c.answer()

@dp.message(F.text == "✍️ Оставить отзыв")
async def review_start(m: Message, state: FSMContext):
    await state.set_state(ReviewState.seller)
    await m.answer("Введите @username или SafeLayer ID продавца:")

@dp.message(ReviewState.seller)
async def review_seller(m: Message, state: FSMContext):
    row = get_seller(m.text)
    if not row: return await m.answer("❌ Продавец не найден. Попробуйте ещё раз.")
    if row["user_id"] == m.from_user.id: return await m.answer("❌ Нельзя оставить отзыв самому себе.")
    old = db.execute("SELECT 1 FROM reviews WHERE seller_id=? AND author_id=?", (row["id"],m.from_user.id)).fetchone()
    if old: return await m.answer("❌ Вы уже оставляли отзыв этому продавцу.")
    await state.update_data(seller_id=row["id"])
    await state.set_state(ReviewState.rating)
    await m.answer("Поставьте оценку: 1, 2, 3, 4 или 5.")

@dp.message(ReviewState.rating)
async def review_rating(m: Message, state: FSMContext):
    if m.text not in {"1","2","3","4","5"}: return await m.answer("Введите число от 1 до 5.")
    await state.update_data(rating=int(m.text))
    await state.set_state(ReviewState.text)
    await m.answer("Напишите отзыв. Опишите факты сделки без оскорблений и личных данных:")

@dp.message(ReviewState.text)
async def review_text(m: Message, state: FSMContext):
    if not m.text or len(m.text.strip()) < 5: return await m.answer("Отзыв должен содержать хотя бы 5 символов.")
    await state.update_data(text=m.text.strip())
    await state.set_state(ReviewState.verified)
    b=InlineKeyboardBuilder()
    b.button(text="✅ Да, сделка подтверждена", callback_data="verified:1")
    b.button(text="Нет", callback_data="verified:0")
    await m.answer("Есть подтверждение сделки?", reply_markup=b.as_markup())

@dp.callback_query(F.data.startswith("verified:"))
async def review_save(c: CallbackQuery, state: FSMContext):
    d=await state.get_data()
    try:
        db.execute("""INSERT INTO reviews(seller_id,author_id,rating,text,verified_deal,status,created_at)
                     VALUES(?,?,?,?,?,'pending',?)""",
                   (d["seller_id"],c.from_user.id,d["rating"],d["text"],int(c.data.endswith(":1")),now()))
        db.commit()
    except sqlite3.IntegrityError:
        await state.clear(); return await c.message.answer("❌ Вы уже оставляли отзыв этому продавцу.")
    await state.clear()
    await c.message.answer("✅ Отзыв отправлен на модерацию. После проверки он появится в профиле продавца.")
    await notify_admins(f"📝 Новый отзыв #{db.execute('SELECT last_insert_rowid()').fetchone()[0]} ожидает модерации.")

@dp.message(F.text == "🏪 Стать продавцом")
async def seller_start(m: Message, state: FSMContext):
    existing=db.execute("SELECT * FROM sellers WHERE user_id=?",(m.from_user.id,)).fetchone()
    if existing: return await m.answer("Вы уже зарегистрированы как продавец.\n\n"+seller_card(existing))
    await state.set_state(SellerState.name)
    await m.answer("Введите название продавца/магазина:")

@dp.message(SellerState.name)
async def seller_name(m: Message,state:FSMContext):
    await state.update_data(name=m.text.strip())
    await state.set_state(SellerState.category)
    await m.answer("Укажите категорию товаров или услуг:")

@dp.message(SellerState.category)
async def seller_cat(m: Message,state:FSMContext):
    await state.update_data(category=m.text.strip())
    await state.set_state(SellerState.description)
    await m.answer("Кратко опишите магазин:")

@dp.message(SellerState.description)
async def seller_desc(m: Message,state:FSMContext):
    d=await state.update_data(description=m.text.strip())
    username=m.from_user.username or ""
    sl_id=f"SL-{m.from_user.id}"
    db.execute("""INSERT INTO sellers(user_id,sl_id,display_name,username,description,category,created_at)
                  VALUES(?,?,?,?,?,?,?)""",
               (m.from_user.id,sl_id,d["name"],username,d["description"],d["category"],now()))
    db.commit(); await state.clear()
    await m.answer(f"✅ Профиль продавца создан.\n\nSafeLayer ID: <code>{sl_id}</code>\n"
                   "Теперь другие пользователи смогут найти вас и оставить отзыв.", reply_markup=main_kb())

@dp.message(F.text.in_(["👤 Мой профиль","📊 Моя репутация"]))
async def my_profile(m: Message):
    row=db.execute("SELECT * FROM sellers WHERE user_id=?",(m.from_user.id,)).fetchone()
    if not row: return await m.answer("У вас ещё нет профиля продавца. Нажмите «🏪 Стать продавцом».")
    await m.answer(seller_card(row))

@dp.callback_query(F.data.startswith("report:"))
async def report_start(c:CallbackQuery,state:FSMContext):
    await state.update_data(review_id=int(c.data.split(":")[1]))
    await state.set_state(ReportState.reason)
    await c.message.answer("Укажите причину жалобы:")
    await c.answer()

@dp.message(ReportState.reason)
async def report_save(m:Message,state:FSMContext):
    d=await state.get_data()
    try:
        db.execute("INSERT INTO reports(review_id,reporter_id,reason,created_at) VALUES(?,?,?,?)",
                   (d["review_id"],m.from_user.id,m.text.strip(),now()))
        db.commit()
        await m.answer("✅ Жалоба отправлена модераторам.")
        await notify_admins(f"⚠️ Новая жалоба на отзыв #{d['review_id']}.")
    except sqlite3.IntegrityError:
        await m.answer("Вы уже жаловались на этот отзыв.")
    await state.clear()

@dp.callback_query(F.data.startswith("reply:"))
async def reply_start(c:CallbackQuery,state:FSMContext):
    rid=int(c.data.split(":")[1])
    r=db.execute("""SELECT r.*,s.user_id FROM reviews r JOIN sellers s ON s.id=r.seller_id WHERE r.id=?""",(rid,)).fetchone()
    if not r or r["user_id"]!=c.from_user.id: return await c.answer("Недоступно",show_alert=True)
    await state.update_data(review_id=rid)
    await state.set_state(ReplyState.text)
    await c.message.answer("Напишите ответ на отзыв:")
    await c.answer()

@dp.message(ReplyState.text)
async def reply_save(m:Message,state:FSMContext):
    d=await state.get_data()
    db.execute("UPDATE reviews SET seller_reply=? WHERE id=?",(m.text.strip(),d["review_id"]))
    db.commit(); await state.clear()
    await m.answer("✅ Ответ сохранён.")

async def notify_admins(text):
    for uid in ADMIN_IDS:
        try: await bot.send_message(uid,text)
        except Exception: pass

@dp.message(Command("admin"))
async def admin(m:Message):
    if m.from_user.id not in ADMIN_IDS: return
    pending=db.execute("SELECT COUNT(*) c FROM reviews WHERE status='pending'").fetchone()["c"]
    reports=db.execute("SELECT COUNT(*) c FROM reports WHERE status='open'").fetchone()["c"]
    await m.answer(f"🛠 <b>Админ-панель</b>\n\n📝 На модерации: {pending}\n⚠️ Открытых жалоб: {reports}\n\n"
                   "Команды:\n/reviews — отзывы на модерации\n/reports — жалобы\n/stats — статистика")

@dp.message(Command("reviews"))
async def admin_reviews(m:Message):
    if m.from_user.id not in ADMIN_IDS: return
    rows=db.execute("""SELECT r.id,r.rating,r.text,s.display_name FROM reviews r
                       JOIN sellers s ON s.id=r.seller_id WHERE r.status='pending'
                       ORDER BY r.created_at LIMIT 20""").fetchall()
    if not rows: return await m.answer("Нет отзывов на модерации.")
    for r in rows:
        b=InlineKeyboardBuilder()
        b.button(text="✅ Одобрить",callback_data=f"modreview:approved:{r['id']}")
        b.button(text="❌ Отклонить",callback_data=f"modreview:rejected:{r['id']}")
        await m.answer(f"#{r['id']} — {r['display_name']} — {r['rating']}/5\n{r['text']}",reply_markup=b.as_markup())

@dp.callback_query(F.data.startswith("modreview:"))
async def modreview(c:CallbackQuery):
    if c.from_user.id not in ADMIN_IDS: return await c.answer("Нет доступа",show_alert=True)
    _,status,rid=c.data.split(":")
    db.execute("UPDATE reviews SET status=? WHERE id=?",(status,int(rid))); db.commit()
    await c.message.edit_reply_markup(reply_markup=None)
    await c.answer("Готово")

@dp.message(Command("reports"))
async def admin_reports(m:Message):
    if m.from_user.id not in ADMIN_IDS: return
    rows=db.execute("""SELECT rp.id,rp.review_id,rp.reason,r.text,s.display_name
                       FROM reports rp JOIN reviews r ON r.id=rp.review_id
                       JOIN sellers s ON s.id=r.seller_id WHERE rp.status='open'
                       ORDER BY rp.created_at LIMIT 20""").fetchall()
    if not rows: return await m.answer("Открытых жалоб нет.")
    for r in rows:
        b=InlineKeyboardBuilder()
        b.button(text="Закрыть жалобу",callback_data=f"closereport:{r['id']}")
        await m.answer(f"Жалоба #{r['id']} на отзыв #{r['review_id']}\n"
                       f"Продавец: {r['display_name']}\nПричина: {r['reason']}\n"
                       f"Отзыв: {r['text']}",reply_markup=b.as_markup())

@dp.callback_query(F.data.startswith("closereport:"))
async def close_report(c:CallbackQuery):
    if c.from_user.id not in ADMIN_IDS: return
    db.execute("UPDATE reports SET status='closed' WHERE id=?",(int(c.data.split(":")[1]),)); db.commit()
    await c.message.edit_reply_markup(reply_markup=None); await c.answer("Закрыто")

@dp.message(Command("stats"))
async def stats(m:Message):
    if m.from_user.id not in ADMIN_IDS: return
    u=db.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    s=db.execute("SELECT COUNT(*) c FROM sellers").fetchone()["c"]
    r=db.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    await m.answer(f"📊 Пользователи: {u}\n🏪 Продавцы: {s}\n📝 Отзывы: {r}")

async def main():
    init_db()
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
