import 'package:flutter_test/flutter_test.dart';
import 'package:fleet_mobile/api.dart';
import 'package:fleet_mobile/main.dart';

void main() {
  testWidgets('login controls', (tester) async {
    await tester.pumpWidget(FleetApp(api: FleetApi('http://127.0.0.1:3080')));
    expect(find.text('Вхід до парку'), findsOneWidget);
    expect(find.text('Користувач'), findsOneWidget);
    expect(find.text('Пароль'), findsOneWidget);
  });
  test('settings boundaries', () {
    expect([null, 29, 31, 131].every((x) => !validSpeed(x)), isTrue);
    expect([30, 60, 130].every(validSpeed), isTrue);
    expect([null, 4, 31].every((x) => !validFuel(x)), isTrue);
    expect([5, 10, 30].every(validFuel), isTrue);
  });
}
