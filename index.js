require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
const userSessions = new Map();
const activeRequests = new Set();
const ORDERS_FILE = path.join(__dirname, 'orders.json');

// Состояния пользователя
const USER_STATE = {
  IDLE: 'idle',
  AWAITING_CAR_INFO: 'awaiting_car',
  AWAITING_PARTS_INFO: 'awaiting_parts',
  AWAITING_PHOTO_OR_VIN: 'awaiting_photo',
  AWAITING_CONTACT: 'awaiting_contact',
  AWAITING_CITY: 'awaiting_city'
};

// Загрузка и сохранение заказов
let clientOrders = new Map();

async function loadOrders() {
  try {
    const raw = await fs.readFile(ORDERS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    clientOrders = new Map(Object.entries(obj).map(([key, val]) => [Number(key), val]));
    console.log('Заказы успешно загружены');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Ошибка загрузки заказов:', err);
    }
    clientOrders = new Map();
  }
}

async function saveOrders() {
  try {
    const obj = Object.fromEntries(clientOrders);
    await fs.writeFile(ORDERS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Ошибка сохранения заказов:', err);
  }
}

// Инициализация бота
loadOrders().then(() => {
  console.log('Бот готов к работе');
}).catch(console.error);

// Главное меню
function showMainMenu(ctx) {
  return ctx.reply(
    'Главное меню:',
    Markup.keyboard([
      ['🔍 Начать подбор запчастей'],
      ['ℹ️ Узнать подробнее'],
      ['📋 Мои заказы']
    ])
    .resize()
    .oneTime()
  );
}

// Обработчики команд
bot.start(async (ctx) => {
  const userId = ctx.chat.id;
  userSessions.set(userId, { state: USER_STATE.IDLE });
  await showMainMenu(ctx);
});

bot.hears('ℹ️ Узнать подробнее', async (ctx) => {
  await ctx.reply(
    `Мы предлагаем:\n\n✅ Подбор оригинальных и аналоговых запчастей\n✅ Работаем с физ. и юр. лицами\n✅ Доставка по всему Крыму\n✅ Гарантия качества\n\nСреднее время подбора - 1-2 часа`,
    Markup.keyboard([
      ['🔍 Начать подбор запчастей'],
      ['⬅️ Главное меню']
    ])
    .resize()
  );
});

bot.hears('🔍 Начать подбор запчастей', async (ctx) => {
  const userId = ctx.chat.id;
  userSessions.set(userId, { state: USER_STATE.AWAITING_CAR_INFO });
  await ctx.reply('Введите данные автомобиля (марка, модель, год, объем двигателя):');
});

bot.hears('📋 Мои заказы', async (ctx) => {
  const userId = ctx.chat.id;
  const orders = clientOrders.get(userId) || [];
  
  if (orders.length === 0) {
    await ctx.reply(
      'У вас пока нет заказов.',
      Markup.keyboard([['⬅️ Главное меню']]).resize()
    );
    return;
  }

  const ordersList = orders.map((order, index) => (
    `Заказ #${index + 1}\n` +
    `🆔 ID: ${order.requestId}\n` +
    `🚗 Авто: ${order.car}\n` +
    `🔧 Запчасти: ${order.parts}\n` +
    `📞 Контакт: ${order.contact}\n` +
    `📍 Город: ${order.city}\n` +
    `📦 Статус: ${order.status}\n` +
    `📅 Дата: ${new Date(order.date).toLocaleString('ru-RU')}\n` +
    `–––––––––––––––––––––––––`
  )).join('\n\n');

  await ctx.reply(
    `Ваши заказы (${orders.length}):\n\n${ordersList}`,
    Markup.keyboard([['⬅️ Главное меню']]).resize()
  );
});

bot.hears('⬅️ Главное меню', async (ctx) => {
  const userId = ctx.chat.id;
  userSessions.delete(userId);
  await showMainMenu(ctx);
});

// Обработка основного потока данных
bot.on('text', async (ctx) => {
  const userId = ctx.chat.id;
  const session = userSessions.get(userId);
  if (!session) return;

  const text = ctx.message.text;

  switch (session.state) {
    case USER_STATE.AWAITING_CAR_INFO:
      session.car = text;
      session.state = USER_STATE.AWAITING_PARTS_INFO;
      await ctx.reply('Какие запчасти вам нужны? Укажите названия или номера:');
      break;

    case USER_STATE.AWAITING_PARTS_INFO:
      session.parts = text;
      session.state = USER_STATE.AWAITING_PHOTO_OR_VIN;
      await ctx.reply('Прикрепите фото детали или VIN (или напишите "пропустить"):');
      break;

    case USER_STATE.AWAITING_PHOTO_OR_VIN:
      session.photoOrVin = text.toLowerCase() === 'пропустить' ? 'Не указано' : text;
      session.state = USER_STATE.AWAITING_CONTACT;
      await ctx.reply('Укажите ваш телефон или Telegram для связи:');
      break;

    case USER_STATE.AWAITING_CONTACT:
      session.contact = text;
      session.state = USER_STATE.AWAITING_CITY;
      await ctx.reply('В каком городе Крыма нужна доставка?');
      break;

    case USER_STATE.AWAITING_CITY:
      session.city = text;
      await completeOrder(ctx, userId);
      break;
  }
});

// Обработка фото
bot.on('photo', async (ctx) => {
  const userId = ctx.chat.id;
  const session = userSessions.get(userId);
  
  if (session?.state === USER_STATE.AWAITING_PHOTO_OR_VIN) {
    const file = ctx.message.photo.pop();
    session.photoOrVin = file.file_id;
    session.photoCaption = ctx.message.caption || '';
    session.state = USER_STATE.AWAITING_CONTACT;
    await ctx.reply('Укажите ваш телефон или Telegram для связи:');
  }
});

// Завершение заказа
async function completeOrder(ctx, userId) {
  const session = userSessions.get(userId);
  const requestId = uuidv4().split('-')[0];
  
  session.requestId = requestId;
  session.status = 'Новая';
  session.date = new Date().toISOString();

  if (!clientOrders.has(userId)) {
    clientOrders.set(userId, []);
  }
  clientOrders.get(userId).push({ ...session });
  await saveOrders();

  // Отправка уведомления админам
  const orderMessage = `Новый заказ #${requestId}\n\n` +
    `👤 Клиент: ${userId}\n` +
    `🚗 Авто: ${session.car}\n` +
    `🔧 Запчасти: ${session.parts}\n` +
    `📞 Контакт: ${session.contact}\n` +
    `📍 Город: ${session.city}`;

  try {
    for (const adminId of adminIds) {
      if (session.photoOrVin.startsWith('Ag')) {
        await bot.telegram.sendPhoto(
          adminId,
          session.photoOrVin,
          {
            caption: orderMessage,
            ...Markup.inlineKeyboard([
              Markup.button.callback('✅ Взять в работу', `take_${userId}_${requestId}`)
            ])
          }
        );
      } else {
        await bot.telegram.sendMessage(
          adminId,
          `${orderMessage}\n📷 VIN/Фото: ${session.photoOrVin}`,
          Markup.inlineKeyboard([
            Markup.button.callback('✅ Взять в работу', `take_${userId}_${requestId}`)
          ])
        );
      }
    }

    await ctx.reply(
      '✅ Ваш заказ принят! Мы свяжемся с вами в течение 1-2 часов.',
      Markup.keyboard([
        ['📋 Мои заказы'],
        ['⬅️ Главное меню']
      ]).resize()
    );
  } catch (err) {
    console.error('Ошибка при отправке заказа:', err);
    await ctx.reply('Произошла ошибка при оформлении заказа. Пожалуйста, попробуйте позже.');
  }

  userSessions.delete(userId);
}

// Обработка callback-ов
bot.action(/^take_(\d+)_(.+)$/, async (ctx) => {
  const [_, userId, requestId] = ctx.match;
  const requestKey = `${userId}_${requestId}`;

  if (activeRequests.has(requestKey)) {
    return await ctx.answerCbQuery('Этот заказ уже в работе');
  }

  activeRequests.add(requestKey);

  try {
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.answerCbQuery('Вы приняли заказ в работу');

    // Обновляем статус заказа
    const orders = clientOrders.get(Number(userId)) || [];
    const orderIndex = orders.findIndex(o => o.requestId === requestId);
    
    if (orderIndex !== -1) {
      orders[orderIndex].status = 'В работе';
      clientOrders.set(Number(userId), orders);
      await saveOrders();
    }

    // Уведомляем клиента
    await bot.telegram.sendMessage(
      userId,
      `🔄 Ваш заказ #${requestId} принят в работу. Мы скоро с вами свяжемся!`
    );

    // Уведомляем других админов
    const adminName = ctx.from.first_name || 'Администратор';
    await Promise.all(
      adminIds
        .filter(id => id !== ctx.from.id)
        .map(id => 
          bot.telegram.sendMessage(
            id,
            `📢 Заказ #${requestId} (клиент ${userId}) принят в работу ${adminName}`
          )
        )
    );
  } catch (err) {
    console.error('Ошибка обработки заказа:', err);
  } finally {
    activeRequests.delete(requestKey);
  }
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error(`Ошибка в чате ${ctx.chat?.id}:`, err);
  ctx.reply('Произошла ошибка. Пожалуйста, попробуйте позже.');
});

// Запуск бота
bot.launch()
  .then(() => console.log('Бот запущен и работает'))
  .catch(err => console.error('Ошибка запуска бота:', err));

// Грациозное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));