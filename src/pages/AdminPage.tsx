import { FormEvent, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { SacredSymbol } from "@/components/SacredSymbol";
import { MetricasDashboard } from "@/components/MetricasDashboard";
import { LogOut, Printer, Trash2 } from "lucide-react";

type Gira = {
  id: string;
  data: string;
  titulo: string;
  capacidade: number;
  tipo?: string | null;
  ativa?: boolean | null;
};

type Agendamento = {
  id: string;
  nome: string;
  primeira_visita: boolean;
  telefone: string | null;
  email: string | null;
  observacoes: string | null;
  created_at: string;
};

// Os campos abaixo vêm do formulário público, ou seja, de qualquer pessoa na
// internet. Tudo o que sai do React (impressão e CSV) precisa ser neutralizado
// antes de virar HTML ou planilha.

const MAPA_ESCAPE_HTML: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapa HTML. Sem isso, um agendamento com <img onerror=...> executaria
 *  script na origem do app ao clicar em "Imprimir lista", dando ao atacante
 *  acesso ao token de sessão da equipe guardado no localStorage. */
function escaparHtml(valor: unknown): string {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => MAPA_ESCAPE_HTML[c]);
}

/** Neutraliza injeção de fórmula em CSV: um campo iniciado por = + - @ (ou
 *  tab/CR) é interpretado como fórmula pelo Excel/LibreOffice ao abrir o
 *  arquivo. O apóstrofo à frente força o conteúdo a ser tratado como texto. */
function neutralizarFormulaCsv(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

export function AdminPage() {
  const [carregandoGiras, setCarregandoGiras] = useState(true);
  const [giras, setGiras] = useState<Gira[]>([]);
  const [giraSelecionadaId, setGiraSelecionadaId] = useState<string | null>(null);

  const [carregandoAgendados, setCarregandoAgendados] = useState(false);
  const [agendados, setAgendados] = useState<Agendamento[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);

  // Autenticação via Supabase Auth (substitui os códigos fixos no bundle)
  const [session, setSession] = useState<Session | null>(null);
  const [checandoSessao, setChecandoSessao] = useState(true);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginSenha, setLoginSenha] = useState("");
  const [loginErro, setLoginErro] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  const [dataEditada, setDataEditada] = useState("");
  const [capacidadeEditada, setCapacidadeEditada] = useState("");
  const [ativaEditada, setAtivaEditada] = useState(false);
  const [salvandoConfig, setSalvandoConfig] = useState(false);
  const [deletandoGira, setDeletandoGira] = useState(false);

  // campos para criar nova gira
  const [tituloNovo, setTituloNovo] = useState("");
  const [dataNova, setDataNova] = useState("");
  const [capacidadeNova, setCapacidadeNova] = useState("");
  const [tipoNovo, setTipoNovo] = useState("");
  const [ativaNova, setAtivaNova] = useState(true);
  const [criandoGira, setCriandoGira] = useState(false);

  const [busca, setBusca] = useState("");

  function formatarDataBr(isoDate: string) {
    const onlyDate = isoDate.split("T")[0];
    const [year, month, day] = onlyDate.split("-");
    return `${day}/${month}/${year}`;
  }

  // sessão de autenticação
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecandoSessao(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evento, novaSessao) => {
      setSession(novaSessao);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const autorizado = !!session;

  // carregar giras
  useEffect(() => {
    const fetchGiras = async () => {
      setCarregandoGiras(true);
      setErro(null);
      setMensagem(null);

      const { data, error } = await supabase
        .from("giras")
        .select("id, data, titulo, capacidade, tipo, ativa")
        .order("data", { ascending: false });

      if (error) {
        console.error(error);
        setErro("Não foi possível carregar as giras.");
        setCarregandoGiras(false);
        return;
      }

      const girasTipadas = (data ?? []) as Gira[];
      setGiras(girasTipadas);

      if (girasTipadas.length > 0) {
        setGiraSelecionadaId(girasTipadas[0].id);
      }

      setCarregandoGiras(false);
    };

    fetchGiras();
  }, []);

  const giraSelecionada = giras.find((g) => g.id === giraSelecionadaId) ?? null;

  // sempre que trocar a gira selecionada, sincroniza os campos editáveis
  useEffect(() => {
    if (giraSelecionada) {
      const onlyDate = giraSelecionada.data.split("T")[0];
      setDataEditada(onlyDate);
      setCapacidadeEditada(String(giraSelecionada.capacidade));
      setAtivaEditada(!!giraSelecionada.ativa);
      setMensagem(null);
      setErro(null);
    } else {
      setDataEditada("");
      setCapacidadeEditada("");
      setAtivaEditada(false);
    }
  }, [giraSelecionada]);

  // carregar agendados
  useEffect(() => {
    const fetchAgendados = async () => {
      if (!giraSelecionadaId) {
        setAgendados([]);
        return;
      }

      setBusca("");
      setCarregandoAgendados(true);
      setErro(null);

      const { data, error } = await supabase
        .from("agendamentos")
        .select("id, nome, primeira_visita, telefone, email, observacoes, created_at")
        .eq("gira_id", giraSelecionadaId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error(error);
        setErro("Não foi possível carregar os agendados desta gira.");
        setCarregandoAgendados(false);
        return;
      }

      setAgendados((data ?? []) as Agendamento[]);
      setCarregandoAgendados(false);
    };

    fetchAgendados();
  }, [giraSelecionadaId]);

  function exportarCSV() {
    if (!giraSelecionada) return;

    const linhas = [
      ["Nome", "Primeira visita", "Telefone", "E-mail", "Observações", "Agendado em"],
      ...agendados.map((a) => [
        a.nome,
        a.primeira_visita ? "Sim" : "Não",
        a.telefone ?? "",
        a.email ?? "",
        a.observacoes ?? "",
        new Date(a.created_at).toLocaleString("pt-BR"),
      ]),
    ];

    const csvConteudo = linhas
      .map((linha) =>
        linha
          .map((campo) => {
            const valor = neutralizarFormulaCsv(campo ?? "");
            const precisaAspas = /[",;\n]/.test(valor);
            if (precisaAspas) {
              return `"${valor.replace(/"/g, '""')}"`;
            }
            return valor;
          })
          .join(";")
      )
      .join("\n");

    const blob = new Blob([csvConteudo], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const nomeArquivo = `agendados_${giraSelecionada.titulo.replace(/\s+/g, "_")}.csv`;

    link.href = url;
    link.setAttribute("download", nomeArquivo);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function imprimirLista() {
    if (!giraSelecionada || agendados.length === 0) return;

    const data = formatarDataBr(giraSelecionada.data);
    const linhas = agendados
      .map(
        (a, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escaparHtml(a.nome)}</td>
          <td style="text-align:center">${a.primeira_visita ? "Sim" : "Não"}</td>
          <td>${escaparHtml(a.telefone ?? "—")}</td>
          <td>${escaparHtml(a.observacoes ?? "")}</td>
          <td style="text-align:center; font-size:16px">&#9744;</td>
        </tr>`
      )
      .join("");

    const html = `<!DOCTYPE html><html lang="pt-BR"><head>
      <meta charset="utf-8">
      <title>Lista — ${escaparHtml(giraSelecionada.titulo)}</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 11px; margin: 24px; color: #222; }
        h1 { font-size: 16px; margin: 0 0 2px; }
        .meta { font-size: 11px; color: #555; margin-bottom: 14px; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #f3ede4; text-align: left; padding: 5px 8px; border: 1px solid #ccc; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; }
        td { padding: 5px 8px; border: 1px solid #ddd; vertical-align: top; }
        tr:nth-child(even) td { background: #fafaf8; }
        .footer { margin-top: 16px; font-size: 10px; color: #999; }
        @media print { body { margin: 12px; } button { display: none; } }
      </style>
    </head><body>
      <h1>${escaparHtml(giraSelecionada.titulo)}${giraSelecionada.tipo ? ` — ${escaparHtml(giraSelecionada.tipo)}` : ""}</h1>
      <div class="meta">Data: ${data} &nbsp;|&nbsp; Total: ${agendados.length} agendados &nbsp;|&nbsp; Capacidade: ${giraSelecionada.capacidade}</div>
      <table>
        <thead>
          <tr>
            <th style="width:30px">#</th>
            <th>Nome</th>
            <th style="width:60px">1ª visita</th>
            <th style="width:110px">Telefone</th>
            <th>Observações</th>
            <th style="width:55px">Presente</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <div class="footer">Terreiro de Umbanda Luzeiro Santo &mdash; impresso em ${new Date().toLocaleString("pt-BR")}</div>
    </body></html>`;

    const janela = window.open("", "_blank");
    if (!janela) return;
    janela.document.write(html);
    janela.document.close();
    // A impressão é disparada daqui, e não por um <script> embutido no HTML:
    // a janela herda o CSP desta página, que não permite script inline.
    janela.focus();
    janela.print();
  }

  async function handleLoginAdmin(e: FormEvent) {
    e.preventDefault();
    setLoginErro(null);
    setEntrando(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail.trim(),
      password: loginSenha,
    });

    if (error) {
      console.error(error);
      setLoginErro("E-mail ou senha inválidos.");
    } else {
      setLoginSenha("");
    }

    setEntrando(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  async function handleSalvarConfig(e: FormEvent) {
    e.preventDefault();
    if (!giraSelecionada) return;

    setErro(null);
    setMensagem(null);

    if (!dataEditada) {
      setErro("Defina uma data para a gira selecionada.");
      return;
    }

    const capacidadeNumero = parseInt(capacidadeEditada, 10);
    if (isNaN(capacidadeNumero) || capacidadeNumero <= 0) {
      setErro("Defina uma capacidade válida (mínimo 1).");
      return;
    }

    setSalvandoConfig(true);

    try {
      // se marcou como ativa, desativar as outras ativas
      if (ativaEditada) {
        const { error: desativaError } = await supabase
          .from("giras")
          .update({ ativa: false })
          .eq("ativa", true);

        if (desativaError) {
          console.error(desativaError);
          setErro(`Erro ao desativar outras giras ativas: ${desativaError.message}`);
          setSalvandoConfig(false);
          return;
        }
      }

      const { data, error } = await supabase
        .from("giras")
        .update({
          data: dataEditada, // formato YYYY-MM-DD
          capacidade: capacidadeNumero,
          ativa: ativaEditada,
        })
        .eq("id", giraSelecionada.id)
        .select("id, data, titulo, capacidade, tipo, ativa")
        .single();

      if (error) {
        console.error(error);
        setErro("Não foi possível salvar as configurações da gira.");
        setSalvandoConfig(false);
        return;
      }

      const giraAtualizada = data as Gira;

      // atualiza lista de giras em memória
      setGiras((prev) =>
        prev.map((g) => (g.id === giraAtualizada.id ? giraAtualizada : g))
      );

      setMensagem("Configurações da gira atualizadas com sucesso.");
    } finally {
      setSalvandoConfig(false);
    }
  }

  async function handleCriarGira(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setMensagem(null);

    if (!dataNova) {
      setErro("Defina a data da nova gira.");
      return;
    }

    const capacidadeNumero = parseInt(capacidadeNova, 10);
    if (isNaN(capacidadeNumero) || capacidadeNumero <= 0) {
      setErro("Defina uma capacidade válida (mínimo 1).");
      return;
    }

    setCriandoGira(true);

    try {
      // se marcar como ativa, desativar as outras ativas
      if (ativaNova) {
        const { error: desativaError } = await supabase
          .from("giras")
          .update({ ativa: false })
          .eq("ativa", true);

        if (desativaError) {
          console.error(desativaError);
          setErro(
            `Erro ao desativar outras giras ativas: ${desativaError.message}`
          );
          setCriandoGira(false);
          return;
        }
      }

      const { data, error } = await supabase
        .from("giras")
        .insert({
          titulo: tituloNovo.trim() || "Gira de Domingo",
          data: dataNova, // YYYY-MM-DD
          capacidade: capacidadeNumero,
          tipo: tipoNovo.trim() || null,
          ativa: ativaNova,
        })
        .select("id, data, titulo, capacidade, tipo, ativa")
        .single();

      if (error) {
        console.error(error);
        setErro(`Erro ao criar gira: ${error.message}`);
        setCriandoGira(false);
        return;
      }

      const novaGira = data as Gira;

      // adiciona na lista local (mantendo ordem por data desc)
      setGiras((prev) =>
        [...prev, novaGira].sort(
          (a, b) => new Date(b.data).getTime() - new Date(a.data).getTime()
        )
      );

      // seleciona automaticamente a nova gira
      setGiraSelecionadaId(novaGira.id);

      // limpa formulário
      setTituloNovo("");
      setDataNova("");
      setCapacidadeNova("");
      setTipoNovo("");
      setAtivaNova(true);

      setMensagem("Nova gira criada com sucesso.");
    } finally {
      setCriandoGira(false);
    }
  }

  async function handleDeletarGira() {
    if (!giraSelecionada) return;

    const totalAgendados = agendados.length;
    const confirmado = window.confirm(
      `Excluir a gira "${giraSelecionada.titulo}" (${formatarDataBr(
        giraSelecionada.data
      )})?\n\n` +
        (totalAgendados > 0
          ? `Isso também apaga os ${totalAgendados} agendamento(s) desta gira. `
          : "") +
        "Esta ação não pode ser desfeita."
    );
    if (!confirmado) return;

    setErro(null);
    setMensagem(null);
    setDeletandoGira(true);

    try {
      // 1) apaga os agendamentos da gira (evita órfãos / violação de FK)
      const { error: erroAgendamentos } = await supabase
        .from("agendamentos")
        .delete()
        .eq("gira_id", giraSelecionada.id);

      if (erroAgendamentos) {
        console.error(erroAgendamentos);
        setErro(`Não foi possível excluir os agendamentos da gira: ${erroAgendamentos.message}`);
        return;
      }

      // 2) apaga a gira
      const { error: erroGira } = await supabase
        .from("giras")
        .delete()
        .eq("id", giraSelecionada.id);

      if (erroGira) {
        console.error(erroGira);
        setErro(`Não foi possível excluir a gira: ${erroGira.message}`);
        return;
      }

      // 3) atualiza estado local: remove da lista e seleciona outra
      const idExcluido = giraSelecionada.id;
      const restantes = giras.filter((g) => g.id !== idExcluido);
      setGiras(restantes);
      setGiraSelecionadaId(restantes.length > 0 ? restantes[0].id : null);
      setAgendados([]);
      setMensagem("Gira excluída com sucesso.");
    } finally {
      setDeletandoGira(false);
    }
  }

  const agendadosFiltrados = busca.trim()
    ? agendados.filter(
        (a) =>
          a.nome.toLowerCase().includes(busca.toLowerCase()) ||
          (a.telefone ?? "").includes(busca)
      )
    : agendados;

  // enquanto verifica se já existe sessão salva
  if (checandoSessao) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <p className="text-sm text-muted-foreground">Verificando acesso...</p>
      </main>
    );
  }

  // tela de login da equipe, com estética Tuluz (agora via Supabase Auth)
  if (!autorizado) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-card rounded-xl shadow-md border border-border/60 p-6 sm:p-8 relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/60 via-primary to-primary/60" />

          <div className="flex flex-col items-center text-center mb-6">
            <SacredSymbol />
            <h1 className="mt-4 text-3xl font-bold text-primary font-playfair tracking-wide">
              Tuluz
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Terreiro de Umbanda Luzeiro Santo
            </p>

            <div className="mt-4 bead-divider">
              <span className="bead"></span>
              <span className="bead"></span>
              <span className="bead"></span>
            </div>
          </div>

          <h2 className="text-lg font-semibold text-center mb-2">
            Área da equipe – Agendamentos
          </h2>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Entre com o e-mail e a senha da equipe para acessar a lista de agendados.
          </p>

          <form onSubmit={handleLoginAdmin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="login-email">
                E-mail
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                className="w-full border rounded-md px-3 py-2 text-sm"
                placeholder="equipe@terreiro.com"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="login-senha">
                Senha
              </label>
              <input
                id="login-senha"
                type="password"
                autoComplete="current-password"
                className="w-full border rounded-md px-3 py-2 text-sm"
                placeholder="Sua senha"
                value={loginSenha}
                onChange={(e) => setLoginSenha(e.target.value)}
                required
              />
            </div>

            {loginErro && (
              <p className="text-sm text-red-600 text-center">{loginErro}</p>
            )}

            <button
              type="submit"
              disabled={entrando}
              className="w-full py-2.5 rounded-md bg-primary text-primary-foreground font-medium text-sm disabled:opacity-60"
            >
              {entrando ? "Entrando..." : "Entrar"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // tela principal do admin com estética da landing
  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* cabeçalho Tuluz */}
        <header className="relative text-center">
          <button
            type="button"
            onClick={handleLogout}
            className="absolute right-0 top-0 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sair
          </button>
          <div className="flex flex-col items-center">
            <SacredSymbol />
            <h1 className="mt-4 text-3xl sm:text-4xl font-bold text-primary font-playfair tracking-wide">
              Tuluz
            </h1>
            <h2 className="text-base sm:text-lg text-foreground/80 mt-1 font-light">
              Área da Equipe – Controle de Agendamentos
            </h2>
            <div className="sacred-divider max-w-xs mx-auto mt-4" />
          </div>
        </header>

        {/* painel de métricas (visão histórica/agregada) */}
        {!carregandoGiras && <MetricasDashboard giras={giras} />}

        {/* card de filtros / info da gira + edição */}
        <section className="bg-card rounded-xl shadow-md border border-border/60 p-6 sm:p-8 relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/60 via-primary to-primary/60" />

          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
            {/* seleção de gira + resumo */}
            <div className="flex-1 min-w-[220px]">
              <p className="text-sm font-medium text-muted-foreground mb-2">
                Selecionar gira
              </p>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={giraSelecionadaId ?? ""}
                onChange={(e) => setGiraSelecionadaId(e.target.value || null)}
              >
                {giras.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.titulo} — {formatarDataBr(g.data)}{" "}
                    {g.tipo ? `(${g.tipo})` : ""} {g.ativa ? "• ativa" : ""}
                  </option>
                ))}
              </select>

              {giraSelecionada && (
                <div className="mt-4 text-sm text-muted-foreground space-y-1">
                  <p>
                    Data:{" "}
                    <span className="font-medium">
                      {formatarDataBr(giraSelecionada.data)}
                    </span>
                  </p>
                  <p>
                    Capacidade:{" "}
                    <span className="font-medium">
                      {giraSelecionada.capacidade} pessoas
                    </span>
                  </p>
                  <p>
                    Status:{" "}
                    <span className="font-medium">
                      {giraSelecionada.ativa ? "Ativa para agendamento" : "Inativa"}
                    </span>
                  </p>
                </div>
              )}
            </div>

            {/* métricas + export */}
            <div className="flex-1 md:max-w-xs space-y-2 text-sm text-muted-foreground">
              <p>
                Giras cadastradas:{" "}
                <span className="font-semibold">{giras.length}</span>
              </p>
              {giraSelecionada && (
                <>
                  <p>
                    Agendados nesta gira:{" "}
                    <span className="font-semibold">{agendados.length}</span>
                  </p>
                  <p>
                    Vagas restantes:{" "}
                    <span className="font-semibold">
                      {Math.max(
                        giraSelecionada.capacidade - agendados.length,
                        0
                      )}
                    </span>
                  </p>
                </>
              )}

              <button
                type="button"
                onClick={exportarCSV}
                disabled={!giraSelecionada || agendados.length === 0}
                className="mt-4 w-full py-2.5 rounded-md bg-primary text-primary-foreground font-medium text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Exportar lista em CSV
              </button>
            </div>

            {/* edição da data/capacidade */}
            {giraSelecionada && (
              <div className="flex-1 md:max-w-xs mt-4 md:mt-0">
                <h3 className="text-sm font-semibold mb-3">
                  Configurações da gira selecionada
                </h3>
                <form onSubmit={handleSalvarConfig} className="space-y-3 text-sm">
                  <div>
                    <label
                      className="block text-xs font-medium mb-1"
                      htmlFor="data-gira-edit"
                    >
                      Data da gira
                    </label>
                    <input
                      id="data-gira-edit"
                      type="date"
                      className="w-full border rounded-md px-3 py-2 text-sm"
                      value={dataEditada}
                      onChange={(e) => setDataEditada(e.target.value)}
                      required
                    />
                  </div>

                  <div>
                    <label
                      className="block text-xs font-medium mb-1"
                      htmlFor="capacidade-edit"
                    >
                      Capacidade (nº de pessoas)
                    </label>
                    <input
                      id="capacidade-edit"
                      type="number"
                      min={1}
                      className="w-full border rounded-md px-3 py-2 text-sm"
                      value={capacidadeEditada}
                      onChange={(e) => setCapacidadeEditada(e.target.value)}
                      required
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Este valor é usado para calcular as vagas restantes na tela de
                      agendamento.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 py-1">
                    <input
                      id="ativa-edit"
                      type="checkbox"
                      checked={ativaEditada}
                      onChange={(e) => setAtivaEditada(e.target.checked)}
                    />
                    <label className="text-xs font-medium" htmlFor="ativa-edit">
                      Gira ativa para o público
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={salvandoConfig}
                    className="w-full py-2.5 rounded-md bg-emerald-600 text-white font-medium text-sm disabled:opacity-60"
                  >
                    {salvandoConfig
                      ? "Salvando configurações..."
                      : "Salvar configurações da gira"}
                  </button>
                </form>

                {/* Zona de perigo: excluir a gira e seus agendamentos */}
                <div className="mt-4 pt-4 border-t border-border/60">
                  <button
                    type="button"
                    onClick={handleDeletarGira}
                    disabled={deletandoGira || salvandoConfig}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-red-300 px-3 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors disabled:opacity-60"
                  >
                    <Trash2 className="h-4 w-4" />
                    {deletandoGira ? "Excluindo..." : "Excluir esta gira"}
                  </button>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Remove a gira e todos os agendamentos ligados a ela. Ação
                    permanente.
                  </p>
                </div>
              </div>
            )}
          </div>

          {erro && (
            <p className="mt-4 text-sm text-red-600">{erro}</p>
          )}
          {mensagem && (
            <p className="mt-2 text-sm text-emerald-600">{mensagem}</p>
          )}
        </section>

        {/* card para criar nova gira */}
        <section className="bg-card rounded-xl shadow-md border border-border/60 p-6 sm:p-8">
          <h3 className="text-base sm:text-lg font-semibold text-foreground mb-4">
            Criar nova gira
          </h3>

          <form onSubmit={handleCriarGira} className="grid gap-4 md:grid-cols-2 text-sm">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium mb-1" htmlFor="titulo-novo">
                Título da gira
              </label>
              <input
                id="titulo-novo"
                type="text"
                className="w-full border rounded-md px-3 py-2 text-sm"
                placeholder="Ex: Gira de Domingo, Gira de Caboclo, etc."
                value={tituloNovo}
                onChange={(e) => setTituloNovo(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1" htmlFor="data-nova">
                Data da gira
              </label>
              <input
                id="data-nova"
                type="date"
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={dataNova}
                onChange={(e) => setDataNova(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1" htmlFor="capacidade-nova">
                Capacidade (nº de pessoas)
              </label>
              <input
                id="capacidade-nova"
                type="number"
                min={1}
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={capacidadeNova}
                onChange={(e) => setCapacidadeNova(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1" htmlFor="tipo-novo">
                Tipo (opcional)
              </label>
              <input
                id="tipo-novo"
                type="text"
                className="w-full border rounded-md px-3 py-2 text-sm"
                placeholder="Ex: gira de caboclo, de preto velho..."
                value={tipoNovo}
                onChange={(e) => setTipoNovo(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-2 mt-2">
              <input
                id="ativa-nova"
                type="checkbox"
                checked={ativaNova}
                onChange={(e) => setAtivaNova(e.target.checked)}
              />
              <label
                className="text-xs font-medium"
                htmlFor="ativa-nova"
              >
                Definir como gira ativa para o público
              </label>
            </div>

            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={criandoGira}
                className="w-full py-2.5 rounded-md bg-primary text-primary-foreground font-medium text-sm disabled:opacity-60"
              >
                {criandoGira ? "Criando gira..." : "Criar nova gira"}
              </button>
            </div>
          </form>
        </section>

        {/* tabela de agendados */}
        <section className="bg-card rounded-xl shadow-md border border-border/60 p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h3 className="text-base sm:text-lg font-semibold text-foreground">
              Agendados da gira selecionada
              {agendados.length > 0 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({agendadosFiltrados.length}/{agendados.length})
                </span>
              )}
            </h3>

            {agendados.length > 0 && (
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="search"
                  placeholder="Buscar por nome ou telefone..."
                  className="w-full sm:w-60 border rounded-md px-3 py-1.5 text-sm"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                />
                <button
                  type="button"
                  onClick={imprimirLista}
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 transition-colors whitespace-nowrap"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Imprimir lista
                </button>
              </div>
            )}
          </div>

          {carregandoGiras || carregandoAgendados ? (
            <p className="text-sm text-muted-foreground">
              Carregando dados...
            </p>
          ) : agendados.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum agendamento encontrado para esta gira.
            </p>
          ) : agendadosFiltrados.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum resultado para "{busca}".
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[500px]">
              <table className="min-w-full text-xs sm:text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2 font-medium">Nome</th>
                    <th className="text-left p-2 font-medium">Primeira visita</th>
                    <th className="text-left p-2 font-medium">Telefone</th>
                    <th className="text-left p-2 font-medium">E-mail</th>
                    <th className="text-left p-2 font-medium">Observações</th>
                    <th className="text-left p-2 font-medium">Agendado em</th>
                  </tr>
                </thead>
                <tbody>
                  {agendadosFiltrados.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="p-2">{a.nome}</td>
                      <td className="p-2">{a.primeira_visita ? "Sim" : "Não"}</td>
                      <td className="p-2 whitespace-nowrap">
                        {a.telefone ?? "-"}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {a.email ?? "-"}
                      </td>
                      <td className="p-2 whitespace-pre-wrap max-w-xs">
                        {a.observacoes ?? "-"}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {new Date(a.created_at).toLocaleString("pt-BR")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="text-center text-xs text-muted-foreground">
          Terreiro de Umbanda Luzeiro Santo • Área interna da equipe
        </footer>
      </div>
    </main>
  );
}
