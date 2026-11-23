// Gate BIL-017-PLANO-NO-APP. Template do autor de gates: copiado para test/features/fluxo_empresas só durante o gate. Abre o painel pelo caminho real:
// DashboardPage -> _FluxoEmpresasScaffold -> _FluxoEmpresasBody -> _buildDashboardTab. Hoje o cartão e o Pix estão só no `builder`, que _FluxoEmpresasBody nunca chama.
// Repositório, API de plano e cubits de conta são falsos, e nada fala com rede.
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fluxo/features/account_context/presentation/bloc/account_context_cubit.dart';
import 'package:fluxo/features/billing/billing_feature_flags.dart';
import 'package:fluxo/features/billing/data/billing_api_datasource.dart';
import 'package:fluxo/features/billing/domain/business_plan_status.dart';
import 'package:fluxo/features/billing/presentation/widgets/business_plan_card.dart';
import 'package:fluxo/features/business_accounts/domain/model/business_account_model.dart';
import 'package:fluxo/features/business_accounts/presentation/bloc/business_accounts_cubit.dart';
import 'package:fluxo/features/fluxo_empresas/domain/fluxo_empresa_models.dart';
import 'package:fluxo/features/fluxo_empresas/domain/fluxo_empresas_repository.dart';
import 'package:fluxo/features/fluxo_empresas/presentation/bloc/fluxo_empresas_cubit.dart';
import 'package:fluxo/features/fluxo_empresas/presentation/pages/fluxo_empresas_pages.dart';
import 'package:fluxo/features/user_coordinated_payments/payment_feature_flags.dart';
import 'package:fluxo/service_locator.dart';
import 'package:intl/date_symbol_data_local.dart';

class _Repo extends Fake implements FluxoEmpresasRepository {
  @override
  Future<FluxoMerchant?> getMerchant(String merchantId) async =>
      const FluxoMerchant(
        id: 'biz-1',
        businessId: 'biz-1',
        name: 'Brasa',
        type: 'restaurant',
      );

  @override
  Stream<List<FluxoMenuCategory>> watchMenu(String merchantId) =>
      Stream.value(const []);

  @override
  Stream<List<FluxoOrder>> watchOrders(String merchantId) =>
      Stream.value(const []);

  @override
  Stream<List<FluxoService>> watchServices(String merchantId) =>
      Stream.value(const []);

  @override
  Stream<List<FluxoAppointment>> watchAppointments(String merchantId) =>
      Stream.value(const []);

  @override
  dynamic noSuchMethod(Invocation invocation) {
    final name = invocation.memberName.toString();
    if (name.contains('watch')) return const Stream<Never>.empty();
    return super.noSuchMethod(invocation);
  }
}

class _Billing extends Fake implements BillingApiDataSource {
  @override
  Future<BusinessPlanStatus?> fetchPlanStatus(String businessId) async => null;
}

class _Accounts extends Cubit<BusinessAccountsState>
    implements BusinessAccountsCubit {
  _Accounts()
    : super(
        const BusinessAccountsState(
          loading: false,
          accounts: [
            BusinessAccount(
              businessId: 'biz-1',
              legalName: 'Brasa Ltda',
              tradeName: 'Brasa',
              fluxoBusinessType: 'FOOD_PLACE',
              verificationLevel: 'none',
              statusCode: 'active',
              trustScore: 0,
              ownerVerifiedCount: 1,
              ownerUids: ['u1'],
              currentUserRole: 'ADMIN',
            ),
          ],
        ),
      );

  @override
  dynamic noSuchMethod(Invocation invocation) => Future<void>.value();
}

class _Context extends Cubit<AccountContextState>
    implements AccountContextCubit {
  _Context() : super(const AccountContextState(loading: false));

  @override
  dynamic noSuchMethod(Invocation invocation) => Future<void>.value();
}

Future<void> _open(WidgetTester tester, {required bool pix}) async {
  await sl.reset();
  sl
    ..registerFactory<BusinessAccountsCubit>(_Accounts.new)
    ..registerFactory<FluxoEmpresasCubit>(() => FluxoEmpresasCubit(_Repo()))
    ..registerSingleton<PaymentFeatureFlags>(PaymentFeatureFlags(enabled: pix))
    ..registerSingleton<BillingFeatureFlags>(
      const BillingFeatureFlags(
        externalLinkIos: false,
        externalLinkAndroid: false,
      ),
    )
    ..registerSingleton<BillingApiDataSource>(_Billing());
  tester.view.physicalSize = const Size(1200, 9000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    BlocProvider<AccountContextCubit>(
      create: (_) => _Context(),
      child: const MaterialApp(home: DashboardPage()),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  setUpAll(() => initializeDateFormatting('pt_BR'));
  tearDown(() => sl.reset());

  testWidgets('plano-no-app: painel real renderiza o cartão do plano', (
    tester,
  ) async {
    await _open(tester, pix: false);
    expect(
      find.text('Painel operacional'),
      findsOneWidget,
      reason: 'o painel real precisa ter aberto',
    );
    expect(find.byType(BusinessPlanCard), findsOneWidget);
  });

  testWidgets('plano-no-app: com a flag, o painel real traz a seção de Pix', (
    tester,
  ) async {
    await _open(tester, pix: true);
    expect(find.text('Pix e pagamentos'), findsOneWidget);
    expect(find.byType(BusinessPlanCard), findsOneWidget);
  });

  testWidgets('plano-no-app: sem a flag, a seção de Pix fica fora', (
    tester,
  ) async {
    await _open(tester, pix: false);
    expect(
      find.text('Painel operacional'),
      findsOneWidget,
      reason: 'o painel real precisa ter aberto',
    );
    expect(find.text('Pix e pagamentos'), findsNothing);
  });
}
