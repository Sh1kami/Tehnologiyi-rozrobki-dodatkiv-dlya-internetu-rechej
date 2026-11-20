# Розгортання локального стенда

Потрібні Docker Desktop і Compose, вільний порт 8080. У папці fleet скопіюйте .env.example у .env та задайте унікальні JWT_SECRET (щонайменше 32 символи) і FLEET_PASSWORD (щонайменше 12). Порт проксі слухає loopback, брокер лишається у внутрішній мережі Compose.

    docker compose config --quiet
    docker compose up -d --build
    docker compose ps

Інтерфейс відкривається на http://127.0.0.1:8080. Користувачі: dispatch-west, dispatch-east і driver з локальним FLEET_PASSWORD. health повертає 200 коли SQLite та MQTT доступні і 503 коли брокер вимкнений. Для публічного середовища потрібні HTTPS, автентифікація брокера та окремі паролі кожного користувача.

    docker compose exec broker mosquitto_pub -h localhost -t fleet/truck-07/telemetry -m '{"ts":1795129200000,"metric":"speed","value":58}'

Для поточного графіка використовуйте поточний Unix-час у мілісекундах. Код src/smoke.js налаштовується через FLEET_URL і FLEET_PASSWORD. Він перевіряє локальне рукостискання Socket.IO, стан health і метрику диспетчерів без друку токена. nginx.conf передає Upgrade, Connection та використовує proxy_read_timeout 75s. Прямий клієнт wscat не замінює протокол Socket.IO.

Перезапуск backend зберігає SQLite в іменованому томі. Для нормального завершення виконайте docker compose down. Для відкату поверніть попередній тег образу або коміт, не видаляючи том, і повторіть health та WS smoke. Публічний хост у межах цієї вправи не налаштовувався.
