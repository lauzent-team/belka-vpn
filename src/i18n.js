'use strict';

/**
 * SleePhy interface translations. Two languages for now: Russian and English.
 *
 * Each row pairs a phrase in both languages. At runtime a phrase is looked up
 * by its exact (whitespace-normalised) text, so one helper covers static markup
 * and strings the renderer builds on the fly.
 *
 * Loaded in the renderer only; the main process needs no translation data.
 */

const PAIRS = [
  [
    "SleePhy",
    "SleePhy"
  ],
  [
    "Private messaging. Your keys, your messages.",
    "Приватный мессенджер. Ключи — у вас, сообщения — у вас."
  ],
  [
    "Sign in",
    "Войти"
  ],
  [
    "Create account",
    "Создать аккаунт"
  ],
  [
    "Username",
    "Имя пользователя"
  ],
  [
    "Password",
    "Пароль"
  ],
  [
    "Repeat password",
    "Повторите пароль"
  ],
  [
    "Your password protects your encryption keys on this device. We can never read your messages.",
    "Пароль защищает ключи шифрования на этом устройстве. Мы не можем читать ваши сообщения."
  ],
  [
    "Server",
    "Сервер"
  ],
  [
    "Welcome back",
    "С возвращением"
  ],
  [
    "Unlock your vault to read messages.",
    "Разблокируйте хранилище, чтобы читать сообщения."
  ],
  [
    "Unlock",
    "Разблокировать"
  ],
  [
    "Use another account",
    "Другой аккаунт"
  ],
  [
    "Users",
    "Пользователи"
  ],
  [
    "No users found.",
    "Никого не найдено."
  ],
  [
    "Archived",
    "Архив"
  ],
  [
    "No chats yet. Use the search box to find someone, or open Saved Messages.",
    "Пока нет чатов. Найдите собеседника через поиск или откройте «Сохранённые сообщения»."
  ],
  [
    "End-to-end encrypted",
    "Сквозное шифрование"
  ],
  [
    "Select a chat",
    "Выберите чат"
  ],
  [
    "Pick a conversation on the left, or search for a username to start one.",
    "Выберите беседу слева или найдите пользователя по нику, чтобы начать."
  ],
  [
    "E2E",
    "E2E"
  ],
  [
    "Pinned message",
    "Закреплённое сообщение"
  ],
  [
    "Reply",
    "Ответ"
  ],
  [
    "Editing message",
    "Изменение сообщения"
  ],
  [
    "Emoji",
    "Смайлики"
  ],
  [
    "Stickers",
    "Стикеры"
  ],
  [
    "Photo",
    "Фото"
  ],
  [
    "File",
    "Файл"
  ],
  [
    "Profile",
    "Профиль"
  ],
  [
    "Bio",
    "О себе"
  ],
  [
    "Public key",
    "Публичный ключ"
  ],
  [
    "Verify this with your contact in person. Your private key never leaves your device.",
    "Сверьте его с собеседником лично. Приватный ключ не покидает устройство."
  ],
  [
    "Send message",
    "Написать сообщение"
  ],
  [
    "Edit profile",
    "Изменить профиль"
  ],
  [
    "Display name",
    "Отображаемое имя"
  ],
  [
    "Avatar colour",
    "Цвет аватара"
  ],
  [
    "Save profile",
    "Сохранить профиль"
  ],
  [
    "Cancel",
    "Отмена"
  ],
  [
    "Change username",
    "Сменить имя пользователя"
  ],
  [
    "Your username is unique and cannot be taken by anyone else.",
    "Имя пользователя уникально, и его не сможет занять никто другой."
  ],
  [
    "New username",
    "Новое имя пользователя"
  ],
  [
    "Claim new username",
    "Занять имя пользователя"
  ],
  [
    "Settings",
    "Настройки"
  ],
  [
    "My account",
    "Мой аккаунт"
  ],
  [
    "Messages and sounds",
    "Сообщения и звуки"
  ],
  [
    "Privacy",
    "Конфиденциальность"
  ],
  [
    "Chat settings",
    "Настройки чатов"
  ],
  [
    "Advanced settings",
    "Расширенные настройки"
  ],
  [
    "Language",
    "Язык"
  ],
  [
    "Admin panel",
    "Админ-панель"
  ],
  [
    "Open profile",
    "Открыть профиль"
  ],
  [
    "Saved messages",
    "Сохранённые сообщения"
  ],
  [
    "Notes and files only you can see",
    "Заметки и файлы, которые видите только вы"
  ],
  [
    "Open",
    "Открыть"
  ],
  [
    "Username",
    "Имя пользователя"
  ],
  [
    "Your public key",
    "Ваш публичный ключ"
  ],
  [
    "Show it to your contact so they can confirm they are writing to you. Your private key never leaves this device.",
    "Покажите его собеседнику, чтобы он убедился, что пишет именно вам. Приватный ключ никогда не покидает это устройство."
  ],
  [
    "Notifications",
    "Уведомления"
  ],
  [
    "Show a popup for new messages",
    "Показывать всплывающее окно о новых сообщениях"
  ],
  [
    "Message text",
    "Текст сообщения"
  ],
  [
    "Show the text in the notification",
    "Показывать текст в уведомлении"
  ],
  [
    "Sounds",
    "Звуки"
  ],
  [
    "Message sound",
    "Звук сообщения"
  ],
  [
    "Play a sound on a new message",
    "Проигрывать звук при новом сообщении"
  ],
  [
    "Test sound",
    "Проверить звук"
  ],
  [
    "Play a short tone",
    "Проиграть короткий сигнал"
  ],
  [
    "Play",
    "Прослушать"
  ],
  [
    "Send with Enter",
    "Отправлять по Enter"
  ],
  [
    "Enter sends, Shift+Enter makes a new line",
    "Enter отправляет, Shift+Enter — новая строка"
  ],
  [
    "Privacy",
    "Приватность"
  ],
  [
    "Show last seen",
    "Показывать «был(а) в сети»"
  ],
  [
    "Contacts see when you were online",
    "Контакты видят, когда вы были онлайн"
  ],
  [
    "Read receipts",
    "Отчёты о прочтении"
  ],
  [
    "Send read marks",
    "Отправлять отметки о прочтении"
  ],
  [
    "Security",
    "Безопасность"
  ],
  [
    "Auto-lock",
    "Автоблокировка"
  ],
  [
    "Lock the vault after idle time",
    "Заблокировать хранилище после простоя"
  ],
  [
    "Never",
    "Никогда"
  ],
  [
    "5 minutes",
    "5 минут"
  ],
  [
    "15 minutes",
    "15 минут"
  ],
  [
    "1 hour",
    "1 час"
  ],
  [
    "Blocked",
    "Заблокированные"
  ],
  [
    "Nobody is blocked",
    "Никто не заблокирован"
  ],
  [
    "Change",
    "Изменить"
  ],
  [
    "The server sees only the username, public key and send time. Message text stays encrypted.",
    "Сервер видит только ник, публичный ключ и время отправки. Текст сообщений остаётся зашифрованным."
  ],
  [
    "Media and storage",
    "Медиа и хранение"
  ],
  [
    "Auto-download photos",
    "Автозагрузка фото"
  ],
  [
    "Open images straight away",
    "Открывать изображения сразу"
  ],
  [
    "Keep media",
    "Хранить медиа"
  ],
  [
    "Cache attachments on this device",
    "Кэшировать вложения на этом устройстве"
  ],
  [
    "1 week",
    "1 неделя"
  ],
  [
    "1 month",
    "1 месяц"
  ],
  [
    "Always",
    "Всегда"
  ],
  [
    "Storage used",
    "Занято памяти"
  ],
  [
    "Clear cache",
    "Очистить кэш"
  ],
  [
    "Appearance",
    "Оформление"
  ],
  [
    "Theme",
    "Тема"
  ],
  [
    "Dark",
    "Тёмная"
  ],
  [
    "Toggle",
    "Переключить"
  ],
  [
    "Chat wallpaper",
    "Обои чата"
  ],
  [
    "Show text in the chat list",
    "Показывать текст в списке чатов"
  ],
  [
    "The last message under the name",
    "Последнее сообщение под именем"
  ],
  [
    "Messenger and window behaviour",
    "Взаимодействие с мессенджером и окном"
  ],
  [
    "Reduce animations",
    "Уменьшить анимации"
  ],
  [
    "Turn off transitions and smooth effects",
    "Отключить переходы и плавные эффекты"
  ],
  [
    "Close with Escape",
    "Закрывать по Escape"
  ],
  [
    "Esc closes open windows",
    "Esc закрывает открытые окна"
  ],
  [
    "Paste without formatting",
    "Вставлять из буфера без форматирования"
  ],
  [
    "Plain text only",
    "Только обычный текст"
  ],
  [
    "Connections",
    "Подключения"
  ],
  [
    "Connection",
    "Соединение"
  ],
  [
    "Server address",
    "Адрес сервера"
  ],
  [
    "Apply server",
    "Применить сервер"
  ],
  [
    "Reconnect",
    "Переподключиться"
  ],
  [
    "Drop the connection and start it again",
    "Разорвать и установить соединение заново"
  ],
  [
    "Again",
    "Заново"
  ],
  [
    "Version",
    "Версия"
  ],
  [
    "Updates",
    "Обновления"
  ],
  [
    "Checked manually",
    "Проверяются вручную"
  ],
  [
    "Check",
    "Проверить"
  ],
  [
    "Reset settings",
    "Сбросить настройки"
  ],
  [
    "Restore the defaults",
    "Вернуть значения по умолчанию"
  ],
  [
    "Reset",
    "Сбросить"
  ],
  [
    "Interface language",
    "Язык интерфейса"
  ],
  [
    "Russian",
    "Русский"
  ],
  [
    "Some labels are still being translated.",
    "Часть подписей пока остаётся на английском — перевод добавляется постепенно."
  ],
  [
    "In development",
    "В разработке"
  ],
  [
    "A subscription that will extend the messenger.",
    "Подписка, которая расширит возможности мессенджера."
  ],
  [
    "What is coming",
    "Что появится"
  ],
  [
    "Larger files",
    "Файлы большего размера"
  ],
  [
    "Unique themes and wallpapers",
    "Уникальные темы и обои"
  ],
  [
    "A badge next to the name",
    "Значок рядом с именем"
  ],
  [
    "Extended message history",
    "Расширенная история сообщений"
  ],
  [
    "Faster media loading",
    "Ускоренная загрузка медиа"
  ],
  [
    "The section does not work yet: subscription options will appear here when the feature is ready.",
    "Раздел ещё не работает: здесь появится оформление подписки, когда функция будет готова."
  ],
  [
    "An in-app currency, like Telegram Stars.",
    "Внутренняя валюта — как звёзды в Telegram."
  ],
  [
    "What is coming",
    "Что появятся"
  ],
  [
    "Support for authors and channels",
    "Поддержка авторов и каналов"
  ],
  [
    "Paid reactions to messages",
    "Платные реакции на сообщения"
  ],
  [
    "Gifts for activity",
    "Подарки за активность"
  ],
  [
    "Paying for the Premium subscription",
    "Оплата подписки Premium"
  ],
  [
    "Balance and purchases are not available yet — the section is in development.",
    "Баланс и покупки пока недоступны — раздел в разработке."
  ],
  [
    "Managing users and announcements",
    "Управление пользователями и объявлениями"
  ],
  [
    "Announce to everyone",
    "Объявление всем"
  ],
  [
    "Every connected user will receive the message.",
    "Сообщение получат все подключённые пользователи."
  ],
  [
    "Send",
    "Отправить"
  ],
  [
    "Users",
    "Пользователи"
  ],
  [
    "checkmark",
    "галочка"
  ],
  [
    "admin",
    "админ"
  ],
  [
    "block",
    "блокировка"
  ],
  [
    "delete",
    "удалить"
  ],
  [
    "No users yet.",
    "Пользователей пока нет."
  ],
  [
    "Sign out",
    "Выйти из аккаунта"
  ],
  [
    "The keys stay on the device — you can sign in again with the same password. To erase the account from the device, open Accounts in the menu.",
    "Ключи остаются на устройстве — войти можно снова с тем же паролем. Чтобы стереть аккаунт с устройства, откройте «Аккаунты» в меню."
  ],
  [
    "Chat",
    "Чат"
  ],
  [
    "Pin",
    "Закрепить"
  ],
  [
    "Mute",
    "Без звука"
  ],
  [
    "Archive",
    "В архив"
  ],
  [
    "Mark as read",
    "Отметить прочитанным"
  ],
  [
    "Clear history",
    "Очистить историю"
  ],
  [
    "Delete chat",
    "Удалить чат"
  ],
  [
    "Edit",
    "Изменить"
  ],
  [
    "Forward",
    "Переслать"
  ],
  [
    "Copy text",
    "Копировать текст"
  ],
  [
    "Select",
    "Выбрать"
  ],
  [
    "Delete",
    "Удалить"
  ],
  [
    "Are you sure?",
    "Вы уверены?"
  ],
  [
    "Enter a value",
    "Введите значение"
  ],
  [
    "Value",
    "Значение"
  ],
  [
    "Save",
    "Сохранить"
  ],
  [
    "Forward to…",
    "Переслать…"
  ],
  [
    "No other chats to forward to yet.",
    "Пока нет других чатов для пересылки."
  ],
  [
    "Accounts",
    "Аккаунты"
  ],
  [
    "My profile",
    "Мой профиль"
  ],
  [
    "Create account or group",
    "Создать аккаунт или группу"
  ],
  [
    "Contacts",
    "Контакты"
  ],
  [
    "New message",
    "Новое сообщение"
  ],
  [
    "Archived",
    "Архив"
  ],
  [
    "Change theme",
    "Сменить тему"
  ],
  [
    "Add account",
    "Добавить аккаунт"
  ],
  [
    "Add",
    "Добавить"
  ],
  [
    "No contacts yet.",
    "Пока нет контактов."
  ],
  [
    "New group",
    "Новая группа"
  ],
  [
    "Group name",
    "Название группы"
  ],
  [
    "Members",
    "Участники"
  ],
  [
    "Create group",
    "Создать группу"
  ],
  [
    "Members receive encrypted copies of every message. The server sees only the member list and ciphertext.",
    "Участники получат зашифрованные копии каждого сообщения. Сервер видит только список участников и шифртекст."
  ],
  [
    "Copied",
    "Скопировано"
  ],
  [
    "Could not copy",
    "Не удалось скопировать"
  ],
  [
    "Pinned",
    "Закреплено"
  ],
  [
    "Unpinned",
    "Откреплено"
  ],
  [
    "Could not pin",
    "Не удалось закрепить"
  ],
  [
    "Message deleted",
    "Сообщение удалено"
  ],
  [
    "Could not delete",
    "Не удалось удалить"
  ],
  [
    "Could not react",
    "Не удалось поставить реакцию"
  ],
  [
    "Muted",
    "Без звука"
  ],
  [
    "Unmuted",
    "Со звуком"
  ],
  [
    "Unarchived",
    "Возвращено из архива"
  ],
  [
    "Marked as read",
    "Отмечено прочитанным"
  ],
  [
    "History cleared",
    "История очищена"
  ],
  [
    "Chat deleted",
    "Чат удалён"
  ],
  [
    "Something went wrong",
    "Что-то пошло не так"
  ],
  [
    "Profile saved",
    "Профиль сохранён"
  ],
  [
    "Message not sent",
    "Сообщение не отправлено"
  ],
  [
    "Could not edit",
    "Не удалось изменить"
  ],
  [
    "Could not unpin",
    "Не удалось открепить"
  ],
  [
    "Could not forward",
    "Не удалось переслать"
  ],
  [
    "You can only delete your own messages",
    "Можно удалять только свои сообщения"
  ],
  [
    "Deleted",
    "Удалено"
  ],
  [
    "Server updated",
    "Сервер обновлён"
  ],
  [
    "Could not reach server",
    "Не удалось подключиться к серверу"
  ],
  [
    "Too large — the limit is {size}",
    "Слишком большой — предел {size}"
  ],
  [
    "Could not read the file",
    "Не удалось прочитать файл"
  ],
  [
    "Could not send the attachment",
    "Не удалось отправить вложение"
  ],
  [
    "Could not open the image",
    "Не удалось открыть изображение"
  ],
  [
    "Could not open the file",
    "Не удалось открыть файл"
  ],
  [
    "Voice recording is not available on this device",
    "Запись голоса недоступна на этом устройстве"
  ],
  [
    "Microphone permission was denied",
    "Доступ к микрофону отклонён"
  ],
  [
    "Recording… tap the microphone again to send",
    "Идёт запись… нажмите микрофон снова, чтобы отправить"
  ],
  [
    "New encrypted message from {name}",
    "Новое зашифрованное сообщение от {name}"
  ],
  [
    "New encrypted group message",
    "Новое зашифрованное сообщение в группе"
  ],
  [
    "Unpin",
    "Открепить"
  ],
  [
    "Close",
    "Закрыть"
  ],
  [
    "Menu",
    "Меню"
  ],
  [
    "Search",
    "Поиск"
  ],
  [
    "Settings",
    "Настройки"
  ],
  [
    "Search in chat",
    "Поиск в чате"
  ],
  [
    "Chat options",
    "Действия с чатом"
  ],
  [
    "Attach",
    "Прикрепить"
  ],
  [
    "Emoji",
    "Эмодзи"
  ],
  [
    "Send",
    "Отправить"
  ],
  [
    "Voice message",
    "Голосовое сообщение"
  ],
  [
    "Write a message…",
    "Напишите сообщение…"
  ],
  [
    "Search in this chat…",
    "Поиск в этом чате…"
  ],
  [
    "Search users or chats",
    "Поиск людей и чатов"
  ],
  [
    "Clear",
    "Очистить"
  ],
  [
    "Open menu",
    "Открыть меню"
  ],
  [
    "Open your profile",
    "Открыть профиль"
  ],
  [
    "Open profile",
    "Открыть профиль"
  ],
  [
    "Messages are end-to-end encrypted",
    "Сообщения защищены сквозным шифрованием"
  ],
  [
    "Verified account",
    "Проверенный аккаунт"
  ],
  [
    "Your name",
    "Ваше имя"
  ],
  [
    "A short line about you",
    "Пара слов о себе"
  ],
  [
    "lowercase, 3–32, a–z 0–9 _",
    "строчные, 3–32, a–z 0–9 _"
  ],
  [
    "at least 8 characters",
    "не менее 8 символов"
  ],
  [
    "repeat your password",
    "повторите пароль"
  ],
  [
    "your password",
    "ваш пароль"
  ],
  [
    "a–z 0–9 _",
    "a–z 0–9 _"
  ],
  [
    "usernames, comma separated",
    "ники через запятую"
  ],
  [
    "Search by username…",
    "Поиск по нику…"
  ],
  [
    "Announcement text…",
    "Текст объявления…"
  ],
  [
    "Phone number",
    "Номер телефона"
  ],
  [
    "+7 999 123-45-67",
    "+7 999 123-45-67"
  ],
  [
    "Send code",
    "Отправить код"
  ],
  [
    "Enter the code",
    "Введите код"
  ],
  [
    "6-digit code",
    "Код из 6 цифр"
  ],
  [
    "Confirm",
    "Подтвердить"
  ],
  [
    "Back",
    "Назад"
  ],
  [
    "We will send a login code to this number. A new number creates a new account.",
    "Мы отправим код для входа на этот номер. Новый номер создаёт новый аккаунт."
  ],
  [
    "Sign in with a phone number",
    "Вход по номеру телефона"
  ],
  [
    "Account password",
    "Пароль аккаунта"
  ],
  [
    "Set a password",
    "Задать пароль"
  ],
  [
    "Change password",
    "Сменить пароль"
  ],
  [
    "Password protects your keys on this device only. You can sign in without it, but then anyone with access to this device can read your messages.",
    "Пароль защищает ключи только на этом устройстве. Можно входить и без него, но тогда любой с доступом к устройству сможет читать ваши сообщения."
  ],
  [
    "Password set",
    "Пароль задан"
  ],
  [
    "No password set",
    "Пароль не задан"
  ],
  [
    "New password",
    "Новый пароль"
  ],
  [
    "Password must be at least 8 characters",
    "Пароль должен быть не короче 8 символов"
  ],
  [
    "Passwords do not match",
    "Пароли не совпадают"
  ],
  [
    "Enter a phone number in international format, e.g. +79991234567",
    "Введите номер в международном формате, например +79991234567"
  ],
  [
    "Enter the 6-digit code",
    "Введите код из 6 цифр"
  ],
  [
    "Wrong code",
    "Неверный код"
  ],
  [
    "The code has expired, request a new one",
    "Код истёк, запросите новый"
  ],
  [
    "Too many attempts, request a new code",
    "Слишком много попыток, запросите новый код"
  ],
  [
    "Request a new code for this number",
    "Запросите новый код для этого номера"
  ],
  [
    "Request a new code",
    "Запросите новый код"
  ],
  [
    "No account for this number",
    "Нет аккаунта для этого номера"
  ],
  [
    "This account signs in by phone number",
    "Этот аккаунт входит по номеру телефона"
  ],
  [
    "Invalid phone number",
    "Неверный номер телефона"
  ],
  [
    "Not authenticated",
    "Вы не авторизованы"
  ],
  [
    "Username: 3–32 characters, a–z, 0–9 or _",
    "Имя: 3–32 символа, a–z, 0–9 или _"
  ],
  [
    "Sending…",
    "Отправка…"
  ],
  [
    "Checking…",
    "Проверка…"
  ],
  [
    "A new account was created for this number.",
    "Для этого номера создан новый аккаунт."
  ],
  [
    "Welcome back. Enter the code to sign in.",
    "С возвращением. Введите код, чтобы войти."
  ],
  [
    "Signed in as @{name}",
    "Вы вошли как @{name}"
  ],
  [
    "Sign out",
    "Выйти из аккаунта"
  ],
  [
    "Change username",
    "Сменить имя пользователя"
  ],
  [
    "We generate your encryption keys on this device. Your password protects them — it never leaves your device.",
    "Мы создаём ключи шифрования на этом устройстве. Пароль защищает их и никуда не отправляется."
  ],
  [
    "Signing in…",
    "Входим…"
  ],
  [
    "Creating…",
    "Создаём…"
  ],
  [
    "Sign in by phone number",
    "Войти по номеру телефона"
  ],
  [
    "Скоро",
    "Скоро"
  ],
  [
    "Wrong username or password",
    "Неверное имя пользователя или пароль"
  ],
  [
    "Username and password required",
    "Введите имя пользователя и пароль"
  ],
  [
    "Username already taken",
    "Это имя уже занято"
  ],
  [
    "Enter a phone number in international format, e.g. +79991234567",
    "Введите номер в международном формате, например +79991234567"
  ],
  [
    "Account badge",
    "Значок аккаунта"
  ],
  [
    "Badge",
    "значок"
  ],
  [
    "The picture is shown instead of the checkmark. Paste it from the clipboard or pick a file.",
    "Картинка показывается вместо галочки. Вставьте её из буфера или выберите файл."
  ],
  [
    "Ctrl+V to paste · or click to pick a file",
    "Ctrl+V — вставить · или нажмите, чтобы выбрать файл"
  ],
  [
    "Picture selected. You can paste another one.",
    "Картинка выбрана. Можно вставить другую."
  ],
  [
    "Remove badge",
    "Убрать значок"
  ],
  [
    "An image is required (PNG, JPEG, GIF or WebP)",
    "Нужна картинка (PNG, JPEG, GIF или WebP)"
  ],
  [
    "The picture is too large",
    "Картинка слишком большая"
  ],
  [
    "Could not read the file",
    "Не удалось прочитать файл"
  ],
  [
    "That does not look like an image",
    "Это не похоже на картинку"
  ],
  [
    "Could not process the picture",
    "Не удалось обработать картинку"
  ],
  [
    "Could not save the badge",
    "Не удалось сохранить значок"
  ],
  [
    "Could not remove the badge",
    "Не удалось убрать значок"
  ],
  [
    "Badge saved",
    "Значок сохранён"
  ],
  [
    "Badge removed",
    "Значок убран"
  ],
  [
    "Replace badge",
    "Заменить значок"
  ],
  [
    "Own badge instead of the checkmark",
    "Свой значок вместо галочки"
  ],
  [
    "Badge image is too large",
    "Значок слишком большой"
  ],
  [
    "Badge image must be a PNG, JPEG, GIF or WebP",
    "Значок должен быть PNG, JPEG, GIF или WebP"
  ],
  [
    "Badge image must be a string",
    "Значок должен быть строкой"
  ]
];

const EN = new Map();
const RU = new Map();
for (const row of PAIRS) {
  const en = row[0];
  const ru = row[1];
  EN.set(en, en);
  EN.set(ru, en);
  RU.set(en, ru);
  RU.set(ru, ru);
}

const LANGUAGES = ['ru', 'en'];
let lang = 'ru';

function normalise(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** The best translation of `text` for language `l`, or the text unchanged. */
function translate(text, l) {
  const map = l === 'en' ? EN : RU;
  return map.get(normalise(text)) || text;
}

function setLang(next) {
  lang = LANGUAGES.includes(next) ? next : 'ru';
  return lang;
}

function getLang() {
  return lang;
}

/** Translate a phrase for the active language, with {placeholder} substitution. */
function t(text, vars) {
  let out = translate(text, lang);
  if (vars) {
    for (const key of Object.keys(vars)) {
      out = out.split('{' + key + '}').join(String(vars[key]));
    }
  }
  return out;
}

const ATTRS = ['placeholder', 'title', 'aria-label'];

/**
 * Translate every text node and labelled attribute under `root` in place.
 * Idempotent: a phrase already in the target language maps to itself.
 */
function apply(root) {
  const scope = root || document.body;
  if (!scope) return;

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue && normalise(node.nodeValue)) nodes.push(node);
    node = walker.nextNode();
  }
  for (const textNode of nodes) {
    const next = translate(textNode.nodeValue, lang);
    if (next !== textNode.nodeValue) textNode.nodeValue = next;
  }

  const selector = ATTRS.map((a) => '[' + a + ']').join(',');
  const elements = scope.querySelectorAll ? scope.querySelectorAll(selector) : [];
  for (const el of elements) {
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const value = el.getAttribute(attr);
      const next = translate(value, lang);
      if (next !== value) el.setAttribute(attr, next);
    }
  }
}

window.i18n = { LANGUAGES, setLang, getLang, t, translate, apply };
