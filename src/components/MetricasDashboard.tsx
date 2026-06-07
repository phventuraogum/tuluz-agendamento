import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CalendarDays,
  RefreshCw,
  Repeat,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

type Gira = {
  id: string;
  data: string;
  titulo: string;
  capacidade: number;
  tipo?: string | null;
  ativa?: boolean | null;
};

type AgendamentoMetric = {
  id: string;
  gira_id: string;
  primeira_visita: boolean | null;
};

type Props = {
  giras: Gira[];
};

const MESES_ABREV = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];

// Cores do tema (definidas em index.css)
const COR_NOVOS = "hsl(var(--primary))"; // terracota
const COR_RECORRENTES = "hsl(var(--secondary))"; // verde folha
const COR_CAPACIDADE = "hsl(var(--muted-foreground))";

function soData(iso: string) {
  return iso.split("T")[0];
}

function rotuloDataBr(iso: string) {
  const [, mes, dia] = soData(iso).split("-");
  return `${dia}/${mes}`;
}

function rotuloMes(chave: string) {
  // chave = "YYYY-MM"
  const [ano, mes] = chave.split("-");
  return `${MESES_ABREV[parseInt(mes, 10) - 1]}/${ano.slice(2)}`;
}

type TooltipPayload = {
  name: string;
  value: number;
  color: string;
  dataKey: string;
};

function TooltipCustomizado({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-md border border-border/70 bg-card px-3 py-2 shadow-md text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((item) => (
        <p key={item.dataKey} className="flex items-center gap-2 text-muted-foreground">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          <span>{item.name}:</span>
          <span className="font-medium text-foreground">{item.value}</span>
        </p>
      ))}
    </div>
  );
}

function KpiCard({
  icone,
  rotulo,
  valor,
  detalhe,
}: {
  icone: React.ReactNode;
  rotulo: string;
  valor: string;
  detalhe?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icone}
        <span className="text-xs font-medium">{rotulo}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground tabular-nums">
        {valor}
      </p>
      {detalhe && (
        <p className="text-[11px] text-muted-foreground mt-0.5">{detalhe}</p>
      )}
    </div>
  );
}

// Gráfico de barras horizontalmente rolável (cada barra tem largura mínima fixa)
function GraficoRolavel({
  dados,
  larguraPorBarra = 56,
  children,
}: {
  dados: unknown[];
  larguraPorBarra?: number;
  children: React.ReactElement;
}) {
  const minWidth = Math.max(560, dados.length * larguraPorBarra);
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth }}>
        <ResponsiveContainer width="100%" height={320}>
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type Aba = "domingo" | "mes" | "ano" | "tipo";

export function MetricasDashboard({ giras }: Props) {
  const [agendamentos, setAgendamentos] = useState<AgendamentoMetric[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aba, setAba] = useState<Aba>("domingo");

  const carregarAgendamentos = useCallback(async () => {
    setCarregando(true);
    setErro(null);

    try {
      const tamanhoPagina = 1000;
      let inicio = 0;
      const todos: AgendamentoMetric[] = [];

      // Pagina para não esbarrar no limite de 1000 linhas do Supabase
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from("agendamentos")
          .select("id, gira_id, primeira_visita")
          .order("created_at", { ascending: true })
          .range(inicio, inicio + tamanhoPagina - 1);

        if (error) throw error;
        const lote = (data ?? []) as AgendamentoMetric[];
        todos.push(...lote);
        if (lote.length < tamanhoPagina) break;
        inicio += tamanhoPagina;
      }

      setAgendamentos(todos);
    } catch (e) {
      console.error(e);
      setErro("Não foi possível carregar as métricas de agendamentos.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregarAgendamentos();
  }, [carregarAgendamentos]);

  const metricas = useMemo(() => {
    const giraPorId = new Map(giras.map((g) => [g.id, g]));

    // Contagem por gira (total e novos)
    const totalPorGira = new Map<string, number>();
    const novosPorGira = new Map<string, number>();

    // Agregações por mês, ano e tipo (chave -> {total, novos})
    const porMesMap = new Map<string, { total: number; novos: number }>();
    const porAnoMap = new Map<string, { total: number; novos: number }>();
    const porTipoMap = new Map<string, { total: number; novos: number }>();

    let totalNovos = 0;

    for (const a of agendamentos) {
      const gira = giraPorId.get(a.gira_id);
      if (!gira) continue; // ignora agendamentos órfãos

      const ehNovo = !!a.primeira_visita;
      if (ehNovo) totalNovos += 1;

      totalPorGira.set(a.gira_id, (totalPorGira.get(a.gira_id) ?? 0) + 1);
      if (ehNovo) novosPorGira.set(a.gira_id, (novosPorGira.get(a.gira_id) ?? 0) + 1);

      const data = soData(gira.data);
      const chaveMes = data.slice(0, 7); // YYYY-MM
      const chaveAno = data.slice(0, 4); // YYYY

      const mes = porMesMap.get(chaveMes) ?? { total: 0, novos: 0 };
      mes.total += 1;
      if (ehNovo) mes.novos += 1;
      porMesMap.set(chaveMes, mes);

      const ano = porAnoMap.get(chaveAno) ?? { total: 0, novos: 0 };
      ano.total += 1;
      if (ehNovo) ano.novos += 1;
      porAnoMap.set(chaveAno, ano);

      const chaveTipo = gira.tipo?.trim() || "Sem tipo";
      const tipo = porTipoMap.get(chaveTipo) ?? { total: 0, novos: 0 };
      tipo.total += 1;
      if (ehNovo) tipo.novos += 1;
      porTipoMap.set(chaveTipo, tipo);
    }

    // Por domingo (uma entrada por gira), ordenado por data crescente
    const porDomingo = [...giras]
      .sort((a, b) => soData(a.data).localeCompare(soData(b.data)))
      .map((g) => {
        const total = totalPorGira.get(g.id) ?? 0;
        const novos = novosPorGira.get(g.id) ?? 0;
        return {
          rotulo: rotuloDataBr(g.data),
          titulo: g.titulo,
          Novos: novos,
          Recorrentes: total - novos,
          total,
          Capacidade: g.capacidade,
        };
      });

    const porMes = [...porMesMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([chave, v]) => ({
        rotulo: rotuloMes(chave),
        Novos: v.novos,
        Recorrentes: v.total - v.novos,
        total: v.total,
      }));

    const porAno = [...porAnoMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([chave, v]) => ({
        rotulo: chave,
        Novos: v.novos,
        Recorrentes: v.total - v.novos,
        total: v.total,
      }));

    // KPIs
    const totalAgendamentos = agendamentos.length;
    const girasComAgendados = porDomingo.filter((d) => d.total > 0).length;
    const mediaPorGira = girasComAgendados
      ? Math.round(totalAgendamentos / girasComAgendados)
      : 0;

    // Ocupação média (apenas giras com público e capacidade definida)
    const girasOcupacao = porDomingo.filter((d) => d.total > 0 && d.Capacidade > 0);
    const ocupacaoMedia = girasOcupacao.length
      ? Math.round(
          (girasOcupacao.reduce((acc, d) => acc + d.total / d.Capacidade, 0) /
            girasOcupacao.length) *
            100
        )
      : 0;

    const pctNovos = totalAgendamentos
      ? Math.round((totalNovos / totalAgendamentos) * 100)
      : 0;

    const porTipo = [...porTipoMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([tipo, v]) => ({
        rotulo: tipo,
        Novos: v.novos,
        Recorrentes: v.total - v.novos,
        total: v.total,
      }));

    return {
      porDomingo,
      porMes,
      porAno,
      porTipo,
      totalAgendamentos,
      totalGiras: giras.length,
      mediaPorGira,
      ocupacaoMedia,
      totalNovos,
      totalRecorrentes: totalAgendamentos - totalNovos,
      pctNovos,
    };
  }, [agendamentos, giras]);

  const dadosAba =
    aba === "domingo"
      ? metricas.porDomingo
      : aba === "mes"
        ? metricas.porMes
        : aba === "ano"
          ? metricas.porAno
          : metricas.porTipo;

  const semDados = !carregando && metricas.totalAgendamentos === 0;

  return (
    <section className="bg-card rounded-xl shadow-md border border-border/60 p-6 sm:p-8 relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/60 via-primary to-primary/60" />

      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-foreground">
            Painel de métricas
          </h3>
          <p className="text-xs text-muted-foreground">
            Agendamentos por data da gira (domingo), mês e ano.
          </p>
        </div>
        <button
          type="button"
          onClick={carregarAgendamentos}
          disabled={carregando}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/60 transition-colors disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${carregando ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </div>

      {erro && <p className="mb-4 text-sm text-red-600">{erro}</p>}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <KpiCard
          icone={<Users className="h-4 w-4" />}
          rotulo="Total de agendamentos"
          valor={metricas.totalAgendamentos.toLocaleString("pt-BR")}
        />
        <KpiCard
          icone={<CalendarDays className="h-4 w-4" />}
          rotulo="Giras cadastradas"
          valor={metricas.totalGiras.toLocaleString("pt-BR")}
        />
        <KpiCard
          icone={<TrendingUp className="h-4 w-4" />}
          rotulo="Média por gira"
          valor={metricas.mediaPorGira.toLocaleString("pt-BR")}
          detalhe="entre giras com público"
        />
        <KpiCard
          icone={<TrendingUp className="h-4 w-4" />}
          rotulo="Ocupação média"
          valor={`${metricas.ocupacaoMedia}%`}
          detalhe="agendados / capacidade"
        />
        <KpiCard
          icone={<Sparkles className="h-4 w-4" />}
          rotulo="Primeira visita"
          valor={metricas.totalNovos.toLocaleString("pt-BR")}
          detalhe={`${metricas.pctNovos}% do total`}
        />
        <KpiCard
          icone={<Repeat className="h-4 w-4" />}
          rotulo="Recorrentes"
          valor={metricas.totalRecorrentes.toLocaleString("pt-BR")}
          detalhe={`${100 - metricas.pctNovos}% do total`}
        />
      </div>

      {/* Abas de período */}
      <div className="flex flex-wrap gap-1 mb-4 border-b border-border/60">
        {([
          ["domingo", "Por domingo"],
          ["mes", "Por mês"],
          ["ano", "Por ano"],
          ["tipo", "Por tipo de gira"],
        ] as [Aba, string][]).map(([valor, texto]) => (
          <button
            key={valor}
            type="button"
            onClick={() => setAba(valor)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
              aba === valor
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {texto}
          </button>
        ))}
      </div>

      {/* Gráfico */}
      {carregando ? (
        <p className="text-sm text-muted-foreground py-12 text-center">
          Carregando métricas...
        </p>
      ) : semDados ? (
        <p className="text-sm text-muted-foreground py-12 text-center">
          Ainda não há agendamentos para exibir métricas.
        </p>
      ) : (
        <GraficoRolavel dados={dadosAba} larguraPorBarra={aba === "ano" || aba === "tipo" ? 90 : 56}>
          <ComposedChart data={dadosAba} margin={{ top: 8, right: 8, left: -16, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="rotulo"
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
              interval={0}
              angle={dadosAba.length > 10 ? -35 : 0}
              textAnchor={dadosAba.length > 10 ? "end" : "middle"}
              height={dadosAba.length > 10 ? 50 : 30}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip content={<TooltipCustomizado />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="Recorrentes" stackId="a" fill={COR_RECORRENTES} radius={[0, 0, 0, 0]} maxBarSize={48} />
            <Bar dataKey="Novos" stackId="a" fill={COR_NOVOS} radius={[4, 4, 0, 0]} maxBarSize={48} />
            {aba === "domingo" && (
              <Line
                type="monotone"
                dataKey="Capacidade"
                stroke={COR_CAPACIDADE}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                dot={false}
                name="Capacidade"
              />
            )}
          </ComposedChart>
        </GraficoRolavel>
      )}
    </section>
  );
}

export default MetricasDashboard;
