// Telegram-бот: уведомления о подписках/отписках в канале и вступлениях/выходах в группе.
// Работает через webhook, без внешних зависимостей (только встроенные модули Node.js).

const http = require('http');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID; // куда слать уведомления
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN. Добавь переменную окружения BOT_TOKEN и перезапусти сервис.');
  process.exit(1);
}

if (!TARGET_CHAT_ID) {
  console.warn(
    'TARGET_CHAT_ID не задан — уведомления пока некуда слать. ' +
    'Добавь бота в чат для уведомлений, напиши там /id, и пропиши полученный ID в переменную TARGET_CHAT_ID.'
  );
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Стабильный, но непубличный путь для webhook — вычислен из токена бота,
// чтобы никто посторонний не мог слать сюда фейковые апдейты.
const WEBHOOK_PATH = '/webhook/' + crypto.createHash('sha256').update(BOT_TOKEN).digest('hex');
const SECRET_TOKEN = crypto.createHash('sha256').update(BOT_TOKEN + ':secret').digest('hex');

async function tgApi(method, payload) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error(`Telegram API ${method} вернул ошибку:`, data);
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDate(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d).replace(',', '');
}

// В чате/канале или уже нет — с учётом статуса restricted, у которого есть is_member.
function isInChat(member) {
  if (!member) return false;
  if (member.status === 'member' || member.status === 'administrator' || member.status === 'creator') {
    return true;
  }
  if (member.status === 'restricted') {
    return !!member.is_member;
  }
  return false; // left, kicked
}

function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || '(без имени)';
}

async function handleChatMember(update) {
  const cmu = update.chat_member;
  const chat = cmu.chat;
  const wasIn = isInChat(cmu.old_chat_member);
  const isNowIn = isInChat(cmu.new_chat_member);

  if (wasIn === isNowIn) return; // не событие входа/выхода (например, назначили админом)

  const user = cmu.new_chat_member.user;
  const isChannel = chat.type === 'channel';
  const joined = !wasIn && isNowIn;

  const header = joined
    ? (isChannel ? '✅ ПОДПИСАЛСЯ' : '✅ ВСТУПИЛ')
    : (isChannel ? '❌ ОТПИСАЛСЯ' : '❌ ВЫШЕЛ');

  const chatLine = isChannel
    ? `📣 Канал: ${escapeHtml(chat.title)}`
    : `👥 Группа: ${escapeHtml(chat.title)}`;

  const nick = user.username
    ? `<a href="https://t.me/${user.username}">@${escapeHtml(user.username)}</a>`
    : 'нет ника';

  const text = [
    `${header}`,
    '➖➖➖➖➖➖➖➖➖➖',
    chatLine,
    `👤 Имя: ${escapeHtml(fullName(user))}`,
    `🔗 Ник: ${nick}`,
    `🆔 ID: <code>${user.id}</code>`,
    `🔑 Профиль: <a href="tg://user?id=${user.id}">ссылка</a>`,
    `🕐 Дата/время: ${formatDate(cmu.date)}`,
  ].join('\n');

  if (!TARGET_CHAT_ID) {
    console.log('TARGET_CHAT_ID не задан, вот что должно было уйти:\n' + text);
    return;
  }

  await tgApi('sendMessage', {
    chat_id: TARGET_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function handleMessage(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const text = msg.text.trim();

  if (text === '/id') {
    await tgApi('sendMessage', {
      chat_id: msg.chat.id,
      text: `ID этого чата: <code>${msg.chat.id}</code>`,
      parse_mode: 'HTML',
    });
    return;
  }

  if (text === '/start' && msg.chat.type === 'private') {
    await tgApi('sendMessage', {
      chat_id: msg.chat.id,
      text:
        'Привет! Я слежу за подписками и отписками в канале/группе, где я админ, ' +
        'и шлю уведомления в настроенный чат.\n\n' +
        'Команда /id покажет ID текущего чата — пригодится для настройки TARGET_CHAT_ID.',
    });
  }
}

async function handleUpdate(update) {
  try {
    if (update.chat_member) {
      await handleChatMember(update);
    } else if (update.message) {
      await handleMessage(update);
    }
  } catch (err) {
    console.error('Ошибка обработки апдейта:', err);
  }
}

async function registerWebhook() {
  const publicHost = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.WEBHOOK_HOST;
  if (!publicHost) {
    console.warn(
      'Не задан RAILWAY_PUBLIC_DOMAIN / WEBHOOK_HOST — webhook не зарегистрирован автоматически. ' +
      'Сгенерируй публичный домен для сервиса и перезапусти его.'
    );
    return;
  }
  const url = `https://${publicHost}${WEBHOOK_PATH}`;
  const res = await tgApi('setWebhook', {
    url,
    secret_token: SECRET_TOKEN,
    allowed_updates: ['chat_member', 'message'],
  });
  if (res.ok) {
    console.log('Webhook зарегистрирован:', url);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('sub-bot жив');
    return;
  }

  if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
    if (req.headers['x-telegram-bot-api-secret-token'] !== SECRET_TOKEN) {
      res.writeHead(401);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      try {
        const update = JSON.parse(body);
        handleUpdate(update);
      } catch (err) {
        console.error('Не удалось разобрать апдейт:', err);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  registerWebhook();
});
