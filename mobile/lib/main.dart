import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart' show LatLng;
import 'package:socket_io_client/socket_io_client.dart' as io;
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';

void main() {
  const configured = String.fromEnvironment('FLEET_URL');
  final origin = kIsWeb
      ? Uri.base.origin
      : kDebugMode
      ? 'http://10.0.2.2:3080'
      : '';
  runApp(FleetApp(api: FleetApi(configured.isEmpty ? origin : configured)));
}

class FleetApp extends StatelessWidget {
  const FleetApp({required this.api, super.key});
  final FleetApi api;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Fleet Watch',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff245650)),
    ),
    home: Login(api: api),
  );
}

class Login extends StatefulWidget {
  const Login({required this.api, super.key});
  final FleetApi api;
  @override
  State<Login> createState() => _Login();
}

class _Login extends State<Login> {
  final user = TextEditingController(text: 'dispatch-west'),
      pass = TextEditingController();
  bool busy = false;
  String? error;
  Future<void> submit() async {
    if (widget.api.url.isEmpty) {
      setState(() => error = 'Потрібна HTTPS-адреса сервера.');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.api.login(user.text, pass.text);
      if (!mounted) return;
      pass.clear();
      await Navigator.push(
        context,
        MaterialPageRoute<void>(builder: (_) => Vehicles(api: widget.api)),
      );
    } catch (e) {
      if (mounted) {
        setState(
          () => error = e is ApiError && e.status == 401
              ? 'Перевірте ім’я та пароль.'
              : 'Сервер недоступний.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    user.dispose();
    pass.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Fleet Watch')),
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 430),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(22),
          children: [
            Text(
              'Вхід до парку',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: user,
              decoration: const InputDecoration(labelText: 'Користувач'),
            ),
            TextField(
              controller: pass,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Пароль'),
              onSubmitted: (_) {
                if (!busy) submit();
              },
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: busy ? null : submit,
              child: Text(busy ? 'Вхід…' : 'Увійти'),
            ),
            if (error != null) Text(error!),
          ],
        ),
      ),
    ),
  );
}

class Vehicles extends StatefulWidget {
  const Vehicles({required this.api, super.key});
  final FleetApi api;
  @override
  State<Vehicles> createState() => _Vehicles();
}

class _Vehicles extends State<Vehicles> {
  late Future<List<Map<String, dynamic>>> data;
  @override
  void initState() {
    super.initState();
    data = widget.api.devices();
  }

  void refresh() => setState(() => data = widget.api.devices());
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Транспорт'),
      actions: [
        IconButton(
          onPressed: refresh,
          tooltip: 'Оновити',
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: FutureBuilder(
      future: data,
      builder: (ctx, state) {
        if (state.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (state.hasError) {
          return Center(
            child: TextButton(
              onPressed: refresh,
              child: const Text('Повторити завантаження'),
            ),
          );
        }
        return ListView(
          children: state.data!
              .map(
                (x) => ListTile(
                  leading: const Icon(Icons.local_shipping_outlined),
                  title: Text(x['name'] as String),
                  subtitle: Text(x['route'] as String),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute<void>(
                      builder: (_) => Detail(api: widget.api, row: x),
                    ),
                  ),
                ),
              )
              .toList(),
        );
      },
    ),
  );
}

class Detail extends StatefulWidget {
  const Detail({required this.api, required this.row, super.key});
  final FleetApi api;
  final Map<String, dynamic> row;
  @override
  State<Detail> createState() => _Detail();
}

class _Detail extends State<Detail> {
  late final io.Socket socket;
  late final Map<String, dynamic> latest;
  late Future<dynamic> series;
  bool live = false, osm = false;
  final mapController = MapController();
  String get id => widget.row['id'] as String;
  Future<dynamic> history() async => widget.api.decode(
    await widget.api.send('GET', '/telemetry?device=$id&metric=fuel'),
  );
  @override
  void initState() {
    super.initState();
    latest = Map<String, dynamic>.from(widget.row['latest'] as Map);
    series = history();
    socket = io.io(
      widget.api.url,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': widget.api.token})
          .disableAutoConnect()
          .build(),
    );
    socket.onConnect((_) {
      if (mounted) setState(() => live = true);
    });
    socket.onDisconnect((_) {
      if (mounted) setState(() => live = false);
    });
    socket.on('geofence:exit', (event) {
      if (!mounted || event is! Map || event['device'] != id) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('Вихід за геозону'),
          action: SnackBarAction(
            label: 'Карта',
            onPressed: () {
              final position = gps();
              if (position != null) mapController.move(position, 14);
            },
          ),
        ),
      );
    });
    socket.on('telemetry:update', (e) {
      if (!mounted || e is! Map || e['device'] != id) return;
      final metric = e['metric'];
      if (metric is String &&
          (latest[metric] == null ||
              (e['ts'] as int) > (latest[metric]['ts'] as int))) {
        setState(() => latest[metric] = e);
      }
    });
    socket.connect();
  }

  @override
  void dispose() {
    socket.dispose();
    mapController.dispose();
    super.dispose();
  }

  num? read(String metric) => latest[metric]?['value'] as num?;
  LatLng? gps() {
    final a = read('lat'), b = read('lon'), ts = latest['lat']?['ts'] as int?;
    if (a == null || b == null || ts == null || latest['lon']?['ts'] != ts) {
      return null;
    }
    return LatLng(a.toDouble(), b.toDouble());
  }

  @override
  Widget build(BuildContext context) {
    final speed = read('speed'), fuel = read('fuel'), position = gps();
    final gpsTimestamp = latest['lat']?['ts'] as int?;
    final stale =
        gpsTimestamp != null &&
        (!live ||
            DateTime.now().millisecondsSinceEpoch - gpsTimestamp > 180000);
    final lastSeen = gpsTimestamp == null
        ? ''
        : TimeOfDay.fromDateTime(
            DateTime.fromMillisecondsSinceEpoch(gpsTimestamp),
          ).format(context);
    final state = fuel == null
        ? 'Немає даних'
        : fuel < 10
        ? 'Критично'
        : fuel <= 20
        ? 'Увага'
        : 'Норма';
    return Scaffold(
      appBar: AppBar(title: Text(widget.row['name'] as String)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(live ? 'З’єднання наживо' : 'Останні доступні дані'),
          const SizedBox(height: 12),
          Text(
            'Швидкість: ${speed == null ? '—' : '${speed.toStringAsFixed(0)} км/год'}',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          Text(
            'Пальне: ${fuel == null ? '—' : '${fuel.toStringAsFixed(1)} %'} · $state',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          Row(
            children: [
              const Expanded(child: Text('Позиція на карті')),
              TextButton(
                onPressed: () => setState(() => osm = !osm),
                child: Text(osm ? 'Схема' : 'Вулиці OSM'),
              ),
            ],
          ),
          SizedBox(
            height: 235,
            child: FlutterMap(
              mapController: mapController,
              options: MapOptions(
                initialCenter: position ?? const LatLng(50.44, 30.52),
                initialZoom: 12,
                backgroundColor: const Color(0xffe6eee6),
              ),
              children: [
                if (osm)
                  TileLayer(
                    urlTemplate:
                        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    userAgentPackageName: 'ua.edu.coursework.fleet_mobile',
                  ),
                PolygonLayer(
                  polygons: [
                    Polygon(
                      points: const [
                        LatLng(50.40, 30.47),
                        LatLng(50.40, 30.57),
                        LatLng(50.48, 30.57),
                        LatLng(50.48, 30.47),
                      ],
                      color: const Color(0x30438370),
                      borderColor: const Color(0xff245650),
                      borderStrokeWidth: 2,
                    ),
                  ],
                ),
                if (position != null)
                  MarkerLayer(
                    markers: [
                      Marker(
                        point: position,
                        child: const Icon(
                          Icons.location_on,
                          color: Color(0xff245650),
                          size: 38,
                        ),
                      ),
                    ],
                  ),
                if (osm)
                  const Align(
                    alignment: Alignment.bottomRight,
                    child: ColoredBox(
                      color: Colors.white,
                      child: Text('© OpenStreetMap'),
                    ),
                  ),
              ],
            ),
          ),
          Text(
            position == null
                ? 'Немає актуальної позиції'
                : stale
                ? 'Остання позиція $lastSeen'
                : 'GPS ${position.latitude.toStringAsFixed(5)}, ${position.longitude.toStringAsFixed(5)}',
          ),
          const SizedBox(height: 16),
          const Text('Залишок пального за добу'),
          FutureBuilder(
            future: series,
            builder: (_, s) {
              if (s.connectionState != ConnectionState.done) {
                return const LinearProgressIndicator();
              }
              if (s.hasError) {
                return TextButton(
                  onPressed: () => setState(() => series = history()),
                  child: const Text('Повторити завантаження історії'),
                );
              }
              final points = s.data['points'] as List;
              return points.isEmpty
                  ? const Text('Показань немає.')
                  : SizedBox(
                      height: 82,
                      child: CustomPaint(
                        painter: FuelLine(
                          points
                              .map((x) => (x['value'] as num).toDouble())
                              .toList(),
                        ),
                        child: const SizedBox.expand(),
                      ),
                    );
            },
          ),
          if (widget.api.role == 'dispatcher')
            OutlinedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => Settings(api: widget.api, id: id),
                ),
              ),
              child: const Text('Налаштування сповіщень'),
            ),
        ],
      ),
    );
  }
}

class FuelLine extends CustomPainter {
  FuelLine(this.points);
  final List<double> points;
  @override
  void paint(Canvas canvas, Size size) {
    final ink = Paint()
      ..color = const Color(0xff245650)
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke;
    final path = Path();
    for (var i = 0; i < points.length; i++) {
      final x = points.length == 1
          ? size.width / 2
          : i * size.width / (points.length - 1);
      final y = (1 - points[i] / 100) * (size.height - 6) + 3;
      if (i == 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
      if (points.length == 1) canvas.drawCircle(Offset(x, y), 3, ink);
    }
    canvas.drawPath(path, ink);
  }

  @override
  bool shouldRepaint(covariant FuelLine old) => old.points != points;
}

class Settings extends StatefulWidget {
  const Settings({required this.api, required this.id, super.key});
  final FleetApi api;
  final String id;
  @override
  State<Settings> createState() => _Settings();
}

class _Settings extends State<Settings> {
  final form = GlobalKey<FormState>(),
      speed = TextEditingController(),
      fuel = TextEditingController();
  String? tag, error;
  bool busy = false;
  LatLng? center;
  double radius = 1000;
  final storage = SharedPreferencesAsync();
  Timer? retryTimer;
  String? queued;
  String get path => '/vehicles/${widget.id}/alert-settings';
  String get zonePath => '/vehicles/${widget.id}/geofence';
  String get queueKey =>
      'fleet-pending:${widget.api.url}:${widget.api.user}:${widget.id}';
  @override
  void initState() {
    super.initState();
    load();
    loadZone();
    retryTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => flushQueue(),
    );
    flushQueue();
  }

  @override
  void dispose() {
    retryTimer?.cancel();
    speed.dispose();
    fuel.dispose();
    super.dispose();
  }

  Future<void> load() async {
    try {
      final r = await widget.api.send('GET', path),
          settings = widget.api.decode(r);
      if (mounted) {
        setState(() {
          tag = r.headers['etag'];
          speed.text = settings['speedLimit'].toString();
          fuel.text = settings['fuelMinPercent'].toString();
          error = null;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Не вдалося завантажити налаштування.');
      }
    }
  }

  Future<void> save() async {
    if (!form.currentState!.validate() || tag == null) return;
    final expected = tag!;
    final values = {
      'speedLimit': int.parse(speed.text),
      'fuelMinPercent': int.parse(fuel.text),
    };
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.api.send('PUT', path, tag: expected, data: values);
      await storage.remove(queueKey);
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Налаштування збережено')));
      }
      await load();
    } catch (e) {
      if (!mounted) return;
      if (e is ApiError && e.status == 412) {
        await storage.remove(queueKey);
        await resolveConflict();
      } else if (e is TimeoutException || e is http.ClientException) {
        await storage.setString(
          queueKey,
          jsonEncode({
            'expires': DateTime.now()
                .add(const Duration(hours: 24))
                .millisecondsSinceEpoch,
            'tag': expected,
            'values': values,
          }),
        );
        if (mounted) {
          setState(() => queued = 'Зміни збережено в черзі на 24 години.');
        }
      } else {
        setState(() => error = 'Зберегти не вдалося. Перевірте з’єднання.');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> flushQueue() async {
    if (busy) return;
    final payload = await storage.getString(queueKey);
    if (!mounted || busy || payload == null) return;
    final pending = jsonDecode(payload) as Map<String, dynamic>;
    if ((pending['expires'] as int) <= DateTime.now().millisecondsSinceEpoch) {
      await storage.remove(queueKey);
      if (mounted) {
        setState(
          () => queued = 'Строк очікування минув. Надішліть зміни знову.',
        );
      }
      return;
    }
    setState(() {
      busy = true;
      queued = 'Відправлення збережених налаштувань…';
    });
    try {
      await widget.api.send(
        'PUT',
        path,
        tag: pending['tag'] as String,
        data: pending['values'],
      );
      await storage.remove(queueKey);
      await load();
      if (mounted) {
        setState(
          () => queued = 'Відкладені налаштування збережено на сервері.',
        );
      }
    } on ApiError catch (exception) {
      if (exception.status == 412 && mounted) {
        final values = pending['values'] as Map<String, dynamic>;
        speed.text = values['speedLimit'].toString();
        fuel.text = values['fuelMinPercent'].toString();
        await storage.remove(queueKey);
        if (mounted) setState(() => queued = null);
        await resolveConflict();
      } else if (mounted) {
        setState(() => queued = 'Сервер поки відхиляє відкладену зміну.');
      }
    } catch (_) {
      if (mounted) setState(() => queued = 'Зміни очікують на з’єднання.');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> resolveConflict() async {
    try {
      final response = await widget.api.send('GET', path);
      final server = widget.api.decode(response);
      if (!mounted) return;
      final keep = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
          title: const Text('Налаштування змінилися'),
          content: Text(
            'Мої: ${speed.text} км/год, ${fuel.text}%\n'
            'Сервер: ${server['speedLimit']} км/год, ${server['fuelMinPercent']}%',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog, false),
              child: const Text('Взяти серверні'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialog, true),
              child: const Text('Залишити мої'),
            ),
          ],
        ),
      );
      if (!mounted || keep == null) return;
      setState(() {
        tag = response.headers['etag'];
        if (keep) {
          error =
              'Власні значення залишено. Натисніть «Зберегти», щоб підтвердити.';
        } else {
          speed.text = server['speedLimit'].toString();
          fuel.text = server['fuelMinPercent'].toString();
          error = null;
        }
      });
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Не вдалося завантажити серверні значення.');
      }
    }
  }

  Future<void> loadZone() async {
    try {
      final zone = widget.api.decode(await widget.api.send('GET', zonePath));
      if (!mounted || center != null || zone['radiusM'] is! num) return;
      setState(() {
        center = LatLng(
          (zone['lat'] as num).toDouble(),
          (zone['lon'] as num).toDouble(),
        );
        radius = (zone['radiusM'] as num).toDouble();
      });
    } catch (_) {
      // The map can still accept a new center when the connection returns.
    }
  }

  Future<void> saveZone() async {
    final target = center;
    if (target == null) return;
    setState(() => busy = true);
    try {
      await widget.api.send(
        'PUT',
        zonePath,
        data: {
          'lat': target.latitude,
          'lon': target.longitude,
          'radiusM': radius.round(),
        },
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Кругову геозону збережено')),
        );
      }
    } catch (_) {
      if (mounted) setState(() => error = 'Не вдалося зберегти геозону.');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Налаштування сповіщень')),
    body: Form(
      key: form,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextFormField(
            controller: speed,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Ліміт швидкості, км/год',
            ),
            validator: (x) => validSpeed(int.tryParse(x ?? ''))
                ? null
                : 'Вкажіть 30–130 із кроком 5.',
          ),
          TextFormField(
            controller: fuel,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Поріг пального, %'),
            validator: (x) => validFuel(int.tryParse(x ?? ''))
                ? null
                : 'Вкажіть ціле число 5–30.',
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: busy || tag == null ? null : save,
            child: const Text('Зберегти'),
          ),
          const SizedBox(height: 24),
          Text('Геозона', style: Theme.of(context).textTheme.titleLarge),
          const Text('Торкніться карти, щоб вибрати центр.'),
          SizedBox(
            height: 220,
            child: FlutterMap(
              options: MapOptions(
                initialCenter: const LatLng(50.44, 30.52),
                initialZoom: 12,
                backgroundColor: const Color(0xffe6eee6),
                onTap: (_, point) {
                  if (!busy) setState(() => center = point);
                },
              ),
              children: [
                if (center != null)
                  CircleLayer(
                    circles: [
                      CircleMarker(
                        point: center!,
                        radius: radius,
                        useRadiusInMeter: true,
                        color: const Color(0x30438370),
                        borderColor: const Color(0xff245650),
                        borderStrokeWidth: 2,
                      ),
                    ],
                  ),
              ],
            ),
          ),
          Text('Радіус: ${radius.round()} м'),
          Slider(
            value: radius,
            min: 100,
            max: 5000,
            divisions: 49,
            label: '${radius.round()} м',
            onChanged: busy ? null : (value) => setState(() => radius = value),
          ),
          OutlinedButton(
            onPressed: busy || center == null ? null : saveZone,
            child: const Text('Зберегти геозону'),
          ),
          if (queued != null) Text(queued!),
          if (error != null) ...[
            Text(error!),
            TextButton(onPressed: load, child: const Text('Оновити поля')),
          ],
        ],
      ),
    ),
  );
}
