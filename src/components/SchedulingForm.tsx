import { FormEvent, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Check } from "lucide-react";

type Gira = {
  id: string;
  data: string;
  titulo: string;
  capacidade: number;
  ocupadas?: number | null;
};

// Conta os agendados de uma gira. Prioriza a função RPC `vagas_gira`, que
// funciona mesmo com o RLS bloqueando a leitura direta da tabela de
// agendamentos (dados pessoais). Se a função ainda não existir no banco,
// cai para a contagem direta — assim o formulário funciona antes e depois
// de aplicar o RLS.
async function contarOcupadas(giraId: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("vagas_gira", {
    p_gira_id: giraId,
  });
  if (!error && typeof data === "number") return data;

  const { count, error: countError } = await supabase
    .from("agendamentos")
    .select("id", { count: "exact", head: true })
    .eq("gira_id", giraId);

  if (countError) {
    console.error(countError);
    return null;
  }
  return count ?? 0;
}

export function SchedulingForm() {
  const [gira, setGira] = useState<Gira | null>(null);
  const [vagasUsadas, setVagasUsadas] = useState<number | null>(null);

  const [loadingGira, setLoadingGira] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [primeiraVez, setPrimeiraVez] = useState<"sim" | "nao">("sim");
  const [observacoes, setObservacoes] = useState("");

  const [mensagem, setMensagem] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  // novo: controle da tela de confirmação
  const [isConfirmed, setIsConfirmed] = useState(false);

  // carrega gira ativa + vagas
  useEffect(() => {
    const carregarDados = async () => {
      setLoadingGira(true);
      setErro(null);

      // gira ativa
      const { data: giras, error } = await supabase
        .from("giras")
        .select("*")
        .eq("ativa", true)
        .order("data", { ascending: true })
        .limit(1);

      if (error) {
        console.error(error);
        setErro("Não foi possível carregar as informações de agendamento.");
        setLoadingGira(false);
        return;
      }

      if (!giras || giras.length === 0) {
        setGira(null);
        setLoadingGira(false);
        return;
      }

      const giraAtiva = giras[0] as Gira;
      setGira(giraAtiva);

      // Conta quantos já agendaram. Preferimos o contador `ocupadas` da própria
      // gira (mantido por trigger): o público pode lê-lo e ele chega ao vivo via
      // Realtime de `giras`. Se a coluna ainda não existir, cai no fallback.
      const ocupadas =
        typeof giraAtiva.ocupadas === "number"
          ? giraAtiva.ocupadas
          : await contarOcupadas(giraAtiva.id);

      if (ocupadas === null) {
        setErro("Não foi possível carregar as vagas restantes.");
        setLoadingGira(false);
        return;
      }

      setVagasUsadas(ocupadas);
      setLoadingGira(false);
    };

    carregarDados();

    // Inscrição em tempo real na tabela `giras`. Toda mudança relevante para o
    // público (capacidade, gira ativa e o contador `ocupadas` atualizado por
    // trigger a cada agendamento) chega por aqui — mantendo a contagem de vagas
    // ao vivo. Não assinamos `agendamentos` porque, com o RLS, o público não a
    // lê e o Realtime dessa tabela não entregaria eventos para o anon.
    const channel = supabase
      .channel("giras-form-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "giras" },
        () => {
          carregarDados();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const capacidade = gira?.capacidade ?? 0;
  const vagasRestantes =
    vagasUsadas !== null && gira ? Math.max(capacidade - vagasUsadas, 0) : null;
  const lotado = vagasRestantes !== null && vagasRestantes <= 0;

  function normalizarNome(nomeBruto: string): string {
    return nomeBruto
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  // formata "2025-12-07" ou "2025-12-07T00:00:00Z" para "07/12/2025"
  function formatarDataBr(isoDate: string) {
    const onlyDate = isoDate.split("T")[0]; // garante só a parte da data
    const [year, month, day] = onlyDate.split("-");
    return `${day}/${month}/${year}`;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    setMensagem(null);

    if (!gira) {
      setErro("No momento não há gira aberta para agendamento.");
      return;
    }

    if (!nome.trim()) {
      setErro("Por favor, preencha o campo de nome completo.");
      return;
    }

    if (!telefone.trim()) {
      setErro("Por favor, preencha o campo de telefone.");
      return;
    }

    if (lotado) {
      setErro("As vagas para esta gira já foram preenchidas.");
      return;
    }

    setSubmitting(true);

    // Re-checa se a gira ainda está ativa no banco antes de prosseguir
    const { data: giraAtual, error: checkError } = await supabase
      .from("giras")
      .select("ativa")
      .eq("id", gira.id)
      .single();

    if (checkError || !giraAtual?.ativa) {
      setErro("Esta gira não está mais disponível para agendamento.");
      setSubmitting(false);
      return;
    }

    const telefoneFinal = telefone.trim();
    const nomeNormalizado = normalizarNome(nome);
    // Normalização simples para garantir que a busca seja consistente com o que é salvo

    // Pré-checagem de duplicidade por telefone na mesma gira.
    // Não é fatal: se o RLS bloquear esta leitura, seguимos em frente e a
    // garantia real fica com o indice unico no banco (erro 23505 tratado abaixo).
    const { data: duplicados, error: dupError } = await supabase
      .from("agendamentos")
      .select("id")
      .eq("gira_id", gira.id)
      .eq("telefone", telefoneFinal)
      .limit(1);

    if (dupError) {
      console.error("Pré-checagem de duplicidade indisponível (seguindo):", dupError);
    } else if (duplicados && duplicados.length > 0) {
      setErro(
        "Já encontramos um agendamento com este telefone para esta gira. Caso precise ajustar algo, por favor fale com a organização."
      );
      setSubmitting(false);
      return;
    }

    // insere agendamento
    const { error: insertError } = await supabase.from("agendamentos").insert({
      gira_id: gira.id,
      nome: nome.trim(),
      nome_normalizado: nomeNormalizado,
      primeira_visita: primeiraVez === "sim",
      observacoes: observacoes.trim() || null,
      telefone: telefoneFinal,
      email: email.trim() || null,
    });

    if (insertError) {
      console.error(insertError);

      const codigo = (insertError as { code?: string }).code ?? "";
      const msg = `${insertError.message ?? ""} ${
        (insertError as { details?: string }).details ?? ""
      }`;

      if (msg.includes("CAPACIDADE_ATINGIDA")) {
        // Perdeu a disputa pela última vaga: o banco barrou. Recarrega a contagem real.
        setErro(
          "As vagas para esta gira foram preenchidas enquanto você agendava. Acompanhe os próximos avisos nos canais oficiais do terreiro."
        );
        const ocupadas = await contarOcupadas(gira.id);
        setVagasUsadas(ocupadas ?? capacidade);
      } else if (msg.includes("GIRA_INATIVA") || msg.includes("GIRA_INEXISTENTE")) {
        setErro("Esta gira não está mais disponível para agendamento.");
      } else if (codigo === "23505") {
        // Índice único no banco pegou a duplicidade (telefone já agendado nesta gira)
        setErro(
          "Já encontramos um agendamento com este telefone para esta gira. Caso precise ajustar algo, por favor fale com a organização."
        );
      } else {
        setErro(
          "Não foi possível concluir seu agendamento. Verifique se já não existe um agendamento em seu nome para esta gira."
        );
      }

      setSubmitting(false);
      return;
    }

    // sucesso
    setMensagem("Seu agendamento foi registrado com sucesso para esta gira.");
    setNome("");
    setTelefone("");
    setEmail("");
    setPrimeiraVez("sim");
    setObservacoes("");

    // atualiza contador de vagas
    const ocupadas = await contarOcupadas(gira.id);
    if (ocupadas !== null) {
      setVagasUsadas(ocupadas);
    }

    setSubmitting(false);
    setIsConfirmed(true); // mostra tela de confirmação
  };

  // 🔸 se já confirmou, mostra o card de sucesso no lugar do formulário
  if (isConfirmed) {
    return (
      <section className="relative">
        <div className="bg-card rounded-xl shadow-md border border-border/60 p-6 sm:p-8 relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/60 via-primary to-primary/60" />

          <div className="flex flex-col items-center text-center py-6 sm:py-8">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
              <Check className="h-9 w-9 text-emerald-600" />
            </div>

            <h3 className="text-2xl sm:text-3xl font-semibold text-primary mb-3 font-playfair">
              Agendamento Confirmado
            </h3>

            <p className="text-sm sm:text-base text-muted-foreground max-w-xl">
              Seu agendamento no Terreiro de Umbanda Luzeiro Santo foi realizado com
              sucesso.
            </p>

            <p className="mt-4 text-base sm:text-lg font-semibold text-emerald-700">
              Axé e até breve.
            </p>

            <button
              type="button"
              onClick={() => {
                setIsConfirmed(false);
                setMensagem(null);
              }}
              className="mt-8 inline-flex items-center justify-center rounded-md border border-[#cba57c] px-5 py-2.5 text-sm font-medium text-[#9b5a2e] bg-white hover:bg-[#f7efe3] transition-colors"
            >
              Fazer novo agendamento
            </button>
          </div>
        </div>
      </section>
    );
  }

  // 🔸 tela normal com formulário
  return (
    <section className="relative">
      <div className="bg-card rounded-xl shadow-md border border-border/60 p-6 sm:p-8 relative overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/60 via-primary to-primary/60" />

        <h3 className="text-xl sm:text-2xl font-semibold text-primary text-center mb-1 font-playfair">
          Realizar Agendamento
        </h3>

        {/* Infos da gira */}
        <div className="text-center mb-6 text-sm text-muted-foreground">
          {loadingGira && <p>Carregando informações da próxima gira...</p>}

          {!loadingGira && !gira && (
            <p>No momento não há gira aberta para agendamento.</p>
          )}

          {gira && (
            <div className="space-y-1">
              <p className="font-medium text-foreground">{gira.titulo}</p>
              <p>
                Data:{" "}
                <span className="font-medium">
                  {formatarDataBr(gira.data)}
                </span>
              </p>
              {lotado && (
                <p className="mt-3 text-xs text-red-600">
                  As vagas para esta gira estão esgotadas. Acompanhe os próximos
                  avisos nos canais oficiais do terreiro.
                </p>
              )}
            </div>
          )}
        </div>

        {erro && (
          <p className="mb-4 text-sm text-red-600 text-center whitespace-pre-line">
            {erro}
          </p>
        )}

        {mensagem && (
          <p className="mb-4 text-sm text-emerald-700 text-center whitespace-pre-line">
            {mensagem}
          </p>
        )}

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="nome">
              Nome completo
            </label>
            <input
              id="nome"
              type="text"
              className="w-full border rounded-md px-3 py-2 text-sm"
              placeholder="Digite seu nome completo"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              disabled={loadingGira || lotado || submitting}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="telefone">
              Telefone / WhatsApp
            </label>
            <input
              id="telefone"
              type="tel"
              className="w-full border rounded-md px-3 py-2 text-sm"
              placeholder="(00) 00000-0000"
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              disabled={loadingGira || lotado || submitting}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="email">
              E-mail (opcional)
            </label>
            <input
              id="email"
              type="email"
              className="w-full border rounded-md px-3 py-2 text-sm"
              placeholder="seuemail@exemplo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loadingGira || lotado || submitting}
            />
          </div>

          <div>
            <p className="block text-sm font-medium mb-1">
              É a sua primeira vez no Terreiro de Umbanda Luzeiro Santo?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <button
                type="button"
                onClick={() => setPrimeiraVez("sim")}
                className={`w-full rounded-md px-3 py-2 border ${primeiraVez === "sim"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-foreground border-border"
                  }`}
                disabled={loadingGira || lotado || submitting}
              >
                Sim, é minha primeira vez
              </button>
              <button
                type="button"
                onClick={() => setPrimeiraVez("nao")}
                className={`w-full rounded-md px-3 py-2 border ${primeiraVez === "nao"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-foreground border-border"
                  }`}
                disabled={loadingGira || lotado || submitting}
              >
                Não, já frequento o terreiro
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="observacoes">
              Observações
            </label>
            <p className="text-xs text-muted-foreground mb-1">
              Nos informe se houver necessidades especiais ou se você é pessoa com
              deficiência (PCD), ou qualquer informação importante para o seu
              atendimento.
            </p>
            <textarea
              id="observacoes"
              className="w-full border rounded-md px-3 py-2 text-sm min-h-[96px]"
              placeholder="Escreva aqui suas observações..."
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              disabled={loadingGira || lotado || submitting}
            />
          </div>

          <button
            type="submit"
            disabled={loadingGira || lotado || submitting}
            className="w-full py-2.5 rounded-md bg-primary text-primary-foreground font-medium text-sm disabled:opacity-70 disabled:cursor-not-allowed mt-2"
          >
            {submitting ? "Enviando..." : "Confirmar agendamento"}
          </button>
        </form>
      </div>
    </section>
  );
}

export default SchedulingForm;
