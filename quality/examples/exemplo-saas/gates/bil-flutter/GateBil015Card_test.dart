// Gates BIL-015. Template do autor de gates: copiado para test/features/billing só durante o gate, removido ao fim.
// Contrato que este template fixa, além da spec: BusinessPlanCard({required String businessId}), lendo BillingFeatureFlags e
// BillingApiDataSource de `sl`, e BillingApiDataSource({required FluxoApiClient apiClient}), como os repositórios do app.
// Nada aqui fala com a API, com a loja ou com o navegador: FluxoApiClient e url_launcher são falsos.
import 'dart:async';
import 'dart:io' show SocketException;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fluxo/core/network/fluxo_api_client.dart';
import 'package:fluxo/features/billing/billing_feature_flags.dart';
import 'package:fluxo/features/billing/data/billing_api_datasource.dart';
import 'package:fluxo/features/billing/presentation/widgets/business_plan_card.dart';
import 'package:get_it/get_it.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:url_launcher/link.dart';
import 'package:url_launcher_platform_interface/link.dart' show LinkDelegate;
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

const _hint = 'gerencie seu plano em ofluxo.app';
const _open = 'Abrir ofluxo.app';
const _off = BillingFeatureFlags(
  externalLinkIos: false,
  externalLinkAndroid: false,
);
const _androidOnly = BillingFeatureFlags(
  externalLinkIos: false,
  externalLinkAndroid: true,
);
const _iosOnly = BillingFeatureFlags(
  externalLinkIos: true,
  externalLinkAndroid: false,
);
final _sale = RegExp(
  r'r\$|\d+[,.]\d{2}|\d\s*%|assinar|comprar|upgrade|a partir de|https?:|www\.|cobran|mensal|anual',
);

Map<String, dynamic> _plan(String plan, String status) => {
  'planCode': plan,
  'status': status,
  'source': 'subscription',
  // Valor hostil: `values` é ignorado, e nada daqui pode aparecer no cartão.
  'values': {
    'preco': 'R\$ 39,90',
    'catalog.items.max': 200,
    'upgrade': 'assinar Pro',
  },
};

class _Api extends Fake implements FluxoApiClient {
  _Api(this.answer);

  Future<Map<String, dynamic>?> Function(String path) answer;
  final paths = <String>[];

  @override
  Future<Map<String, dynamic>?> getJson(
    String path, {
    bool authenticated = true,
  }) {
    paths.add(path);
    return answer(path);
  }
}

class _Launcher extends UrlLauncherPlatform with MockPlatformInterfaceMixin {
  final urls = <String>[];

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> canLaunch(String url) async => true;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    urls.add(url);
    return true;
  }
}

Future<_Api> _pump(
  WidgetTester tester, {
  BillingFeatureFlags flags = _off,
  Future<Map<String, dynamic>?> Function(String path)? answer,
  String businessId = 'biz-1',
}) async {
  final api = _Api(answer ?? (_) async => _plan('local', 'active'));
  final sl = GetIt.instance;
  sl.registerSingleton<BillingFeatureFlags>(flags);
  sl.registerSingleton<BillingApiDataSource>(
    BillingApiDataSource(apiClient: api),
  );
  addTearDown(sl.reset);
  await tester.pumpWidget(_host(businessId));
  await tester.pumpAndSettle();
  return api;
}

Widget _host(String businessId) => MaterialApp(
  home: Scaffold(body: BusinessPlanCard(businessId: businessId)),
);

Finder get _card => find.byType(BusinessPlanCard);

Finder _inCard(Finder finder) => find.descendant(of: _card, matching: finder);

/// Tudo o que está escrito no cartão, inclusive em RichText e Text.rich.
String _text(WidgetTester tester) => _inCard(
  find.byType(RichText),
).evaluate().map((e) => (e.widget as RichText).text.toPlainText()).join('\n');

bool _hasRecognizer(InlineSpan span) {
  var found = false;
  span.visitChildren((child) {
    if (child is TextSpan && child.recognizer != null) found = true;
    return !found;
  });
  return found;
}

/// Qualquer coisa do cartão que reaja a toque, abra link ou deixe copiar: o que o iOS não pode ter.
List<String> _actions(WidgetTester tester) =>
    _inCard(find.byWidgetPredicate((_) => true))
        .evaluate()
        .map((e) => e.widget)
        .where(
          (w) =>
              w is GestureDetector ||
              w is RawGestureDetector ||
              w is InkResponse ||
              w is ButtonStyleButton ||
              w is IconButton ||
              w is FloatingActionButton ||
              w is Link ||
              w is SelectableText ||
              (w is Semantics && (w.properties.link ?? false)) ||
              (w is Semantics && (w.properties.button ?? false)) ||
              (w is RichText && _hasRecognizer(w.text)),
        )
        .map((w) => w.runtimeType.toString())
        .toList();

void main() {
  final ios = TargetPlatformVariant.only(TargetPlatform.iOS);
  final android = TargetPlatformVariant.only(TargetPlatform.android);
  final both = TargetPlatformVariant({
    TargetPlatform.iOS,
    TargetPlatform.android,
  });
  late UrlLauncherPlatform originalLauncher;
  late _Launcher launcher;

  setUp(() {
    originalLauncher = UrlLauncherPlatform.instance;
    launcher = _Launcher();
    UrlLauncherPlatform.instance = launcher;
  });
  tearDown(() => UrlLauncherPlatform.instance = originalLauncher);

  testWidgets(
    'sem-compra-ios: mostra plano, status e o texto exato, em Text simples',
    (tester) async {
      await _pump(tester);
      expect(find.text('Plano: Local'), findsOneWidget);
      expect(find.text('Ativo'), findsOneWidget);
      expect(find.text(_hint), findsOneWidget);
      expect(tester.widget(find.text(_hint)), isA<Text>());
    },
    variant: both,
  );

  testWidgets('sem-compra-ios: nenhum preço, botão, link ou ação de compra', (
    tester,
  ) async {
    await _pump(tester);
    expect(
      _text(tester),
      contains(_hint),
      reason: 'sem o cartão na tela, o resto do teste não provaria nada',
    );
    expect(_actions(tester), isEmpty);
    expect(_text(tester).toLowerCase(), isNot(matches(_sale)));
    expect(find.text(_open), findsNothing);
  }, variant: ios);

  testWidgets(
    'sem-compra-ios: tocar em qualquer texto do cartão não abre nada',
    (tester) async {
      await _pump(tester);
      for (final element in _inCard(find.byType(Text)).evaluate().toList()) {
        await tester.tap(find.byWidget(element.widget), warnIfMissed: false);
        await tester.pumpAndSettle();
      }
      expect(launcher.urls, isEmpty);
    },
    variant: ios,
  );

  testWidgets(
    'sem-compra-ios: em past_due o cartão não fala em cobrança nem oferece saída',
    (tester) async {
      await _pump(tester, answer: (_) async => _plan('local', 'past_due'));
      expect(find.text('Pagamento pendente'), findsOneWidget);
      expect(_actions(tester), isEmpty);
      expect(_text(tester).toLowerCase(), isNot(matches(_sale)));
    },
    variant: ios,
  );

  testWidgets('sem-compra-ios: sem assinatura não vira convite para assinar', (
    tester,
  ) async {
    await _pump(tester, answer: (_) async => _plan('presenca', 'none'));
    expect(find.text('Plano: Presença'), findsOneWidget);
    expect(find.text('Sem assinatura'), findsOneWidget);
    expect(_actions(tester), isEmpty);
    expect(_text(tester).toLowerCase(), isNot(matches(_sale)));
  }, variant: ios);

  testWidgets(
    'sem-compra-ios: o sensor de ação enxerga o botão do Android, então o vazio do iOS vale',
    (tester) async {
      await _pump(tester, flags: _androidOnly);
      expect(_actions(tester), isNotEmpty);
    },
    variant: android,
  );

  test(
    'flag-desligada: as duas flags nascem false e nada abre fora de iOS e Android',
    () {
      final flags = BillingFeatureFlags.fromEnvironment();
      expect(flags.externalLinkIos, isFalse);
      expect(flags.externalLinkAndroid, isFalse);
      for (final platform in TargetPlatform.values) {
        expect(
          flags.externalLinkEnabledFor(platform),
          isFalse,
          reason: '$platform',
        );
      }
      const on = BillingFeatureFlags(
        externalLinkIos: true,
        externalLinkAndroid: true,
      );
      for (final platform in TargetPlatform.values) {
        expect(
          on.externalLinkEnabledFor(platform),
          platform == TargetPlatform.iOS || platform == TargetPlatform.android,
          reason: '$platform',
        );
      }
    },
  );

  test('flag-desligada: uma plataforma não liga a outra', () {
    expect(_androidOnly.externalLinkEnabledFor(TargetPlatform.iOS), isFalse);
    expect(_androidOnly.externalLinkEnabledFor(TargetPlatform.android), isTrue);
    expect(_iosOnly.externalLinkEnabledFor(TargetPlatform.android), isFalse);
    expect(_iosOnly.externalLinkEnabledFor(TargetPlatform.iOS), isTrue);
  });

  testWidgets(
    'flag-desligada: flag ligada só no Android deixa o iOS sem link',
    (tester) async {
      await _pump(tester, flags: _androidOnly);
      expect(find.text(_open), findsNothing);
      expect(_actions(tester), isEmpty);
    },
    variant: ios,
  );

  testWidgets(
    'flag-desligada: flag desligada no Android também não mostra link',
    (tester) async {
      await _pump(tester, flags: _iosOnly);
      expect(find.text(_open), findsNothing);
      expect(_actions(tester), isEmpty);
    },
    variant: android,
  );

  testWidgets(
    'flag-desligada: flag ligada no Android abre a página do plano da empresa',
    (tester) async {
      await _pump(tester, flags: _androidOnly);
      await tester.tap(find.text(_open));
      await tester.pumpAndSettle();
      expect(launcher.urls, ['https://ofluxo.app/app/business/biz-1/plano']);
    },
    variant: android,
  );

  testWidgets(
    'estados-do-cartao: lê só os entitlements da empresa, nunca catálogo nem assinatura',
    (tester) async {
      final api = await _pump(tester);
      expect(api.paths, hasLength(1));
      expect(
        api.paths.single,
        contains('billing/subjects/business/biz-1/entitlements'),
      );
    },
  );

  for (final entry in const {
    'presenca': 'Presença',
    'local': 'Local',
    'pro': 'Pro',
    'rede': 'Rede',
    'plano_novo': 'Plano ativo',
  }.entries) {
    testWidgets('estados-do-cartao: plano ${entry.key} vira ${entry.value}', (
      tester,
    ) async {
      await _pump(tester, answer: (_) async => _plan(entry.key, 'active'));
      expect(find.text('Plano: ${entry.value}'), findsOneWidget);
    });
  }

  for (final entry in const {
    'active': 'Ativo',
    'trialing': 'Em teste',
    'past_due': 'Pagamento pendente',
    'paused': 'Pausado',
    'pending_cancellation': 'Cancelamento agendado',
    'none': 'Sem assinatura',
    'estado_novo': 'Em atualização',
  }.entries) {
    testWidgets('estados-do-cartao: status ${entry.key} vira ${entry.value}', (
      tester,
    ) async {
      await _pump(tester, answer: (_) async => _plan('local', entry.key));
      expect(find.text(entry.value), findsOneWidget);
    });
  }

  final failures = <String, Future<Map<String, dynamic>?> Function(String)>{
    '404': (_) async => null,
    '403': (_) async =>
        throw HttpException('forbidden', statusCode: 403, body: ''),
    '500': (_) async => throw HttpException('boom', statusCode: 500, body: ''),
    'timeout': (_) async => throw TimeoutException('lento'),
    'sem rede': (_) async => throw const SocketException('offline'),
  };
  failures.forEach((name, answer) {
    testWidgets('estados-do-cartao: $name oculta o cartão sem quebrar a tela', (
      tester,
    ) async {
      await _pump(tester, answer: answer);
      expect(find.text(_hint), findsNothing);
      expect(find.textContaining('Plano'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets(
    'estados-do-cartao: trocar de empresa não deixa o plano anterior na tela',
    (tester) async {
      final second = Completer<Map<String, dynamic>?>();
      final api = await _pump(
        tester,
        answer: (path) async =>
            path.contains('biz-1') ? _plan('local', 'active') : second.future,
      );
      expect(find.text('Plano: Local'), findsOneWidget);
      await tester.pumpWidget(_host('biz-2'));
      await tester.pump();
      expect(
        find.text('Plano: Local'),
        findsNothing,
        reason: 'plano da empresa anterior enquanto a nova carrega',
      );
      second.complete(_plan('pro', 'active'));
      await tester.pumpAndSettle();
      expect(find.text('Plano: Pro'), findsOneWidget);
      expect(api.paths.last, contains('biz-2'));
    },
  );

  testWidgets(
    'estados-do-cartao: resposta atrasada da empresa anterior é descartada',
    (tester) async {
      final late = Completer<Map<String, dynamic>?>();
      await _pump(
        tester,
        answer: (path) async =>
            path.contains('biz-1') ? late.future : _plan('pro', 'active'),
      );
      await tester.pumpWidget(_host('biz-2'));
      await tester.pumpAndSettle();
      expect(find.text('Plano: Pro'), findsOneWidget);
      late.complete(_plan('local', 'active'));
      await tester.pumpAndSettle();
      expect(find.text('Plano: Pro'), findsOneWidget);
      expect(find.text('Plano: Local'), findsNothing);
    },
  );

  testWidgets(
    'estados-do-cartao: empresa nova sem acesso esconde o cartão anterior',
    (tester) async {
      await _pump(
        tester,
        answer: (path) async {
          if (path.contains('biz-1')) return _plan('local', 'active');
          throw HttpException('forbidden', statusCode: 403, body: '');
        },
      );
      await tester.pumpWidget(_host('biz-2'));
      await tester.pumpAndSettle();
      expect(find.text(_hint), findsNothing);
    },
  );
}
