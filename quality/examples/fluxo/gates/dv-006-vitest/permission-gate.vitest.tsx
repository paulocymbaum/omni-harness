// Gate DV-006-PERMISSION-ROUTES (dono: quality/test/delivery/dv-006.test.mjs). Copiado para admin-web/src/__dv006_gate_*__/
// só durante a execução do gate. Contrato: PermissionGate aceita anyOf além de permission (comportamento atual
// inalterado) e adminLandingPath leva quem só tem debates.operate para /debates.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

vi.mock("../shared/presentation/i18n/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { PermissionGate } from "../modules/auth/presentation/PermissionGate";
import { AdminSessionProvider } from "../modules/auth/presentation/AdminSessionContext";
import { adminLandingPath } from "../modules/auth/domain/landing";
import type { AdminPermission, AdminSession } from "../shared/domain/contracts";

const session = (capabilities: string[]) =>
  ({ uid: "u1", email: "op@example.org", role: "operator", displayName: "Op", capabilities, expiresAt: "2099-01-01T00:00:00Z" }) as unknown as AdminSession;
const mount = (capabilities: string[], gate: ReactNode) =>
  render(
    <MemoryRouter>
      <AdminSessionProvider session={session(capabilities)}>{gate}</AdminSessionProvider>
    </MemoryRouter>,
  );
const debatesAny = ["debates.manage", "debates.operate"] as unknown as AdminPermission[];
type GateProps = Parameters<typeof PermissionGate>[0];
const anyOfProps = (anyOf: AdminPermission[]) => ({ anyOf }) as unknown as GateProps;

afterEach(cleanup);

describe("gate DV-006 permission routes", () => {
  it("anyOf abre a tela com qualquer uma das permissões", () => {
    mount(["debates.operate"], <PermissionGate {...anyOfProps(debatesAny)}><p>tela-debates</p></PermissionGate>);
    expect(screen.queryByText("tela-debates")).not.toBeNull();
    cleanup();
    mount(["debates.manage"], <PermissionGate {...anyOfProps(debatesAny)}><p>tela-debates</p></PermissionGate>);
    expect(screen.queryByText("tela-debates")).not.toBeNull();
  });

  it("anyOf sem nenhuma das permissões mostra o PermissionGate", () => {
    mount(["users.read", "debates.review"], <PermissionGate {...anyOfProps(debatesAny)}><p>tela-debates</p></PermissionGate>);
    expect(screen.queryByText("tela-debates")).toBeNull();
    expect(screen.queryByText("permission.title")).not.toBeNull();
  });

  it("permission única continua igual", () => {
    mount(["users.read"], <PermissionGate permission="users.read"><p>pessoas</p></PermissionGate>);
    expect(screen.queryByText("pessoas")).not.toBeNull();
    cleanup();
    mount(["debates.manage"], <PermissionGate permission={"debates.operate" as AdminPermission}><p>mesa</p></PermissionGate>);
    expect(screen.queryByText("mesa")).toBeNull();
    expect(screen.queryByText("permission.title")).not.toBeNull();
  });

  it("quem só tem debates.operate entra em /debates; dashboard continua prioritário", () => {
    expect(adminLandingPath(["session.read", "debates.operate"] as AdminPermission[])).toBe("/debates");
    expect(adminLandingPath(["dashboard.read", "debates.operate"] as AdminPermission[])).toBe("/");
  });
});
