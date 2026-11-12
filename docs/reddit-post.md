# Текст для Reddit (SleePhy 0.16.11)

Куда постить: r/opensource, r/privacy, r/selfhosted, r/программирование,
r/Разработка, r/ru_dev. Для англоязычных сабов используйте перевод ниже.

---

## Вариант 1 — основной (r/opensource, r/ru_dev, r/программирование)

**Заголовок:**
Я делаю SleePhy — десктопный мессенджер с настоящим E2E-шифрованием, где сервер
физически не может прочитать вашу переписку. Скачать .exe можно уже сейчас

**Тело:**

Всем привет! Хочу показать проект, над которым я работаю: **SleePhy** — это
настольный мессенджер для Windows и Linux, построенный вокруг одной идеи. Сервер
не должен знать, о чём вы переписываетесь.

Я устал от того, что «шифрование» в мессенджерах обычно означает «мы обещаем не
читать». Здесь иначе: сервер — это «слепой» релей. Он принимает шифротекст,
хранит его и пересылает дальше. У него нет ключей. Даже если завтра кто-то
заберёт базу целиком, он получит набор нечитаемых байтов и метаданные.

**Как это устроено**

- Ключи рождаются на вашем компьютере. Приватный ключ шифруется вашим паролем
  и лежит в файле `sleephy-identity.json` с правами `0600`. Он не уходит на
  сервер — ни при регистрации, ни когда-либо потом.
- Шифрование — [libsodium](https://doc.libsodium.org/), без самодельной
  криптографии: X25519 для ключей, `crypto_box` (XSalsa20-Poly1305) для
  сообщений, scrypt для пароля.
- Тесты проверяют это напрямую: после обмена сообщениями в базе сервера не
  должно быть ни одного открытого слова. Если шифрование сломается, тест упадёт.

**Что уже работает** (это не макет, всё живое)

- Переписка один-на-один с E2E-шифрованием, ответы, редактирование, удаление
- Реакции, индикатор набора текста, онлайн-статус
- **Один компьютер — до трёх аккаунтов** (с Premium — до пяти). Лимит считает
  релей по идентификатору установки, так что завести сотню одноразовых учёток
  «в один клик» не выйдет
- **Огонёк** — сколько дней подряд вы писали друг другу
- **Самоуничтожающиеся сообщения** — таймер на чат, релей физически стирает
  шифротекст по истечении
- **Отложенные сообщения** — «отправить позже», релей держит шифротекст до часа
  отправки и ничего не знает о содержимом
- **Проверка ключей (safety number)** — двенадцать групп цифр, выведенных из
  обоих публичных ключей. Число одинаково на обоих концах и никогда не идёт на
  сервер, поэтому, сверив его голосом, вы точно знаете, что сервер не подменил
  ключ
- Группы, каналы, боты и мини-игры (крестики-нолики, морской бой) прямо в чате
- Опросы, сторис на 24 часа
- Звонки — аудио и видео, один-на-один и групповые, с демонстрацией экрана.
  Медиа идёт peer-to-peer через WebRTC, релей пересылает только рукопожатие
- Встроенный музыкальный плеер
- Поиск людей, поиск внутри чата с фильтрами и **глобальный поиск по тексту
  сообщений** — запрос расшифровывается и ищется на устройстве, поэтому сама
  поисковая строка никуда не уходит

**Честно о том, чего пока нет**

Я не хочу продавать это как «неубиваемый защищённый мессенджер», потому что это
было бы неправдой. Вот реальный список:

- **Нет forward secrecy.** Если приватный ключ утечёт, прошлые сообщения
  раскроются. Нужен Double Ratchet, и это следующий большой пункт.
- **Проверка ключей ручная.** Приложение показывает safety number, но не
  заставляет сверять его до первого сообщения.
- **Метаданные видит сервер** — кто с кем, когда и какого размера сообщения.
- **Один ключ на аккаунт, один девайс.** Мультидевайса пока нет.
- **История живёт на сервере** шифротекстом до «Очистить историю».
- **Аккаунт нельзя восстановить.** Потеряли пароль — потеряли ключи. Это цена
  того, что ключи не у нас.
- Платежи (внутренняя валюта и подписка) **выключены, пока владелец релея не
  подключит платёжный сервис**: покупка отклоняется, а не зачисляется. Демо-режим
  для показа включается отдельным флагом и денег не берёт.

Полный список с деталями — в README, раздел «Что ещё не сделано».

**Скачать**

Windows 10/11 (x64), установщик:
https://github.com/lauzent-team/belka-vpn/releases/latest

Установщик уже настроен на рабочий релей, вводить адрес не нужно. Придумываете
логин и пароль — и всё.

Исходники, тесты и документация: https://github.com/lauzent-team/belka-vpn

**Стек:** Electron, Node.js, `node:sqlite` на сервере, libsodium для
криптографии. Лицензия MIT.

Буду рад вопросам и критике. Особенно интересно, что вы считаете правильным
следующим шагом: Double Ratchet для forward secrecy или мультидевайс. И если
кто-то захочет поднять свой релей — в репозитории есть пошаговые инструкции, в
том числе как обойтись без зарубежной карты.

---

## Вариант 2 — английский (r/opensource, r/privacy, r/selfhosted)

**Title:**
I built SleePhy, a desktop messenger with real end-to-end encryption where the
server literally cannot read your messages. Windows installer is ready

**Body:**

Hi all! I want to share a project I have been working on: **SleePhy**, a desktop
messenger for Windows and Linux built around one idea — the server should not
know what you are saying.

I got tired of "encryption" in messengers usually meaning "we promise not to
read". Here it is different. The server is a **blind relay**: it accepts
ciphertext, stores it and forwards it. It holds no keys. If someone walked away
with the whole database tomorrow, they would get unreadable bytes and metadata.

**How it works**

- Keys are generated on your machine. The private key is encrypted with your
  password and stored in `sleephy-identity.json` with `0600` permissions. It
  never goes to the server — not at sign-up, not ever.
- Encryption is [libsodium](https://doc.libsodium.org/), no hand-rolled crypto:
  X25519 for keys, `crypto_box` (XSalsa20-Poly1305) for messages, scrypt for the
  password.
- The tests assert this directly: after two accounts exchange messages, no
  readable text may appear in the server database. If encryption breaks, the
  test fails.

**What already works** (this is not a mock-up)

- One-to-one chat with E2E encryption, replies, edits, deletes
- Reactions, typing indicators, presence
- **Up to three accounts per computer** (five with Premium). The relay counts
  them per installation, so spinning up a hundred throwaway accounts is not a
  one-click affair
- A per-chat streak counter ("how many days in a row you wrote to each other")
- **Self-destructing messages** — set a timer per chat; the relay wipes the
  ciphertext when it expires
- **Scheduled messages** — the relay holds the ciphertext until the chosen time
  and learns nothing about the content
- **Key verification (safety numbers)** — twelve groups of digits derived from
  both public keys, identical on both ends and never sent to the server, so
  reading it aloud over another channel proves the server did not swap a key
- Groups, channels, bots and mini-games inside a chat
- Polls, 24-hour stories
- Audio and video calls, one-to-one and group, with screen sharing. Media is
  peer-to-peer over WebRTC; the relay only forwards the handshake
- A built-in music player
- User search, in-chat search with filters, and **global message search** — the
  query is decrypted and matched on your device, so the query itself never
  leaves it

**Honestly, what is missing**

I do not want to sell this as an unbreakable secure messenger, because that
would not be true. Here is the real list:

- **No forward secrecy.** If the private key leaks, past messages are exposed. A
  Double Ratchet is the fix, and it is the next big item.
- **Key verification is manual.** The app shows a safety number but does not
  force a comparison before the first message.
- **Metadata is visible to the server** — who talks to whom, when, and message
  sizes.
- **One key per account, one device.** No multi-device support yet.
- **History lives on the server** as ciphertext until you clear the chat.
- **Accounts cannot be recovered.** Lose the password, lose the keys. That is
  the cost of not holding your keys.
- Payments (in-app currency and subscription) are **off until the relay owner
  connects a payment provider**: a purchase is refused rather than credited. A
  demo mode exists for showing the flow and moves no money.

The full list is in the README under "What is not done yet".

**Download**

Windows 10/11 (x64) installer:
https://github.com/lauzent-team/belka-vpn/releases/latest

The installer already points at a working relay — no address to type. Pick a
username and password and you are in.

Source, tests and docs: https://github.com/lauzent-team/belka-vpn

**Stack:** Electron, Node.js, `node:sqlite` on the server, libsodium for crypto.
MIT licensed.

Happy to answer questions and take criticism. I am especially curious what you
think the right next step is: Double Ratchet for forward secrecy, or
multi-device. And if anyone wants to run their own relay, the repo has
step-by-step guides.

---

## Короткий вариант (для комментариев и твитов)

SleePhy — десктопный E2E-мессенджер, где сервер реально слепой: он хранит
шифротекст и не имеет ключей. libsodium, ключи только на устройстве, честный
список того, чего пока нет. Установщик для Windows:
https://github.com/lauzent-team/belka-vpn/releases/latest

---

## Советы по постингу

- В r/privacy и r/selfhosted подчёркивайте, что релей можно поднять самому, и
  сразу признавайте отсутствие forward secrecy — там это ценят выше всего.
- В r/opensource и r/ru_dev лучше заходит история «почему я это делаю» и список
  того, что уже работает.
- Не пишите «неубиваемое шифрование» или «анонимно». В этих сабах за такое
  разберут, и справедливо.
- Отвечайте на вопросы про метаданные спокойно: это честно признано в README.
- Лучшее время для r/opensource и r/privacy — утро по США (вечер по МСК).
