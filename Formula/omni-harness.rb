# Homebrew — fórmula do Omni Harness (template).
#
# 1) Publique o repo no GitHub e crie a release v0.1.0 com o tarball do fonte
#    (o `files` do package.json não se aplica ao brew: a fórmula empacota o repo inteiro
#    menos exemplos; ajuste o `url`/`sha256` abaixo).
# 2) Crie um tap (ex.: <ORG>/homebrew-tap), copie esta pasta Formula/ para lá e ajuste <ORG>.
# 3) Instalação no hospedeiro:
#      brew tap <ORG>/tap && brew install omni-harness
#      omni-harness init <destino> --nome <projeto>
class OmniHarness < Formula
  desc "Núcleo agnóstico de agentes de código: hooks, gates, ciclo de entrega (Claude Code + Cline)"
  homepage "https://github.com/<ORG>/omni-harness"
  url "https://github.com/<ORG>/omni-harness/archive/refs/tags/v0.1.0.tar.gz"
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000" # brew audit/sha256sum do tarball
  depends_on "node@22"

  def install
    # Núcleo inteiro em libexec; o CLI resolve o motor relativo ao próprio arquivo.
    libexec.install Dir["quality/*"], "scripts", "docs", ".gitignore"
    (bin/"omni-harness").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node@22"].opt_bin}/node" "#{libexec}/bin/omni-harness.mjs" "$@"
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/omni-harness --version")
  end
end
