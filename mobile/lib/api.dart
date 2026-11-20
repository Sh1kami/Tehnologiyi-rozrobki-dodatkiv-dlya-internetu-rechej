import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiError implements Exception {
  final int status;
  ApiError(this.status);
}

class FleetApi {
  FleetApi(this.url);
  final String url;
  String? token, role;
  Future<http.Response> send(
    String method,
    String path, {
    Object? data,
    String? tag,
  }) async {
    final r = http.Request(method, Uri.parse('$url/api/v1$path'));
    if (token != null) r.headers['Authorization'] = 'Bearer $token';
    if (tag != null) r.headers['If-Match'] = tag;
    if (data != null) {
      r.headers['Content-Type'] = 'application/json';
      r.body = jsonEncode(data);
    }
    final reply = await http.Response.fromStream(
      await r.send().timeout(const Duration(seconds: 5)),
    );
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      throw ApiError(reply.statusCode);
    }
    return reply;
  }

  dynamic decode(http.Response r) => jsonDecode(utf8.decode(r.bodyBytes));
  Future<void> login(String user, String pass) async {
    final value = decode(
      await send(
        'POST',
        '/auth/login',
        data: {'username': user, 'password': pass},
      ),
    );
    token = value['accessToken'] as String;
    role = value['role'] as String;
  }

  Future<List<Map<String, dynamic>>> devices() async =>
      (decode(await send('GET', '/devices')) as List)
          .cast<Map<String, dynamic>>();
}

bool validSpeed(int? x) => x != null && x >= 30 && x <= 130 && x % 5 == 0;
bool validFuel(int? x) => x != null && x >= 5 && x <= 30;
