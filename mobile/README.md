# Fleet Watch Mobile

Flutter-клієнт працює з API в папці fleet. Симулятор Android під час debug використовує 10.0.2.2:3080. Для пристрою задайте адресу через --dart-define=FLEET_URL=https://… . Вебзбірку можна покласти в fleet/dist/mobile після flutter build web --base-href /mobile/. Вона бере поточний origin.

    flutter pub get
    flutter analyze
    flutter test

Список і деталі підтримують повторне завантаження. Live-координата використовує Socket.IO, а зміна порогів — If-Match. Стан 412 вимагає оновити значення перед повтором. Демонстраційний скрин зроблено на Flutter Web у Chromium.
