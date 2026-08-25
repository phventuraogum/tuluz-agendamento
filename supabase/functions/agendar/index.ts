// Edge Function: agendar
// -----------------------------------------------------------------------------
// Caminho ÚNICO de escrita de agendamentos, para acabar com o bypass do site
// apontado no pentest (F1): qualquer script conseguia agendar direto na API do
// Supabase, sem carregar a página. Aqui o insert só passa se:
//   1) o navegador resolver um desafio Cloudflare Turnstile (CAPTCHA) — é o que
//      derruba a automação; um bot não resolve isso em escala de graça;
//   2) a origem da chamada estiver na allowlist (barra outros sites; é camada
//      secundária, pois cabeçalho é forjável fora do navegador);
//   3) os dados passarem na validação (mesmos limites do formulário).
// O insert é feito com a SERVICE ROLE (ignora RLS/grant), então continua
// funcionando mesmo depois de REVOGAR o INSERT do papel anônimo. Os triggers do
// banco (gira ativa, capacidade, freio de vazão, dedupe) continuam valendo.
//
// Segredos/vars de ambiente (Supabase → Edge Functions → Secrets):
//   TURNSTILE_SECRET        — secret key do Cloudflare Turnstile
//   ALLOWED_ORIGINS         — origens permitidas, separadas por vírgula
//                             ex: https://tuluz-agendamento.vercel.app,https://www.luzeirosanto.com.br
//   SUPABASE_URL            — injetado automaticamente pelo Supabase
//   SUPABASE_SERVICE_ROLE_KEY — injetado automaticamente pelo Supabase
// -----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET") ?? "";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const LIMITES = { nome: 120, telefone: 20, email: 254, observacoes: 500 };

function corsHeaders(origin: string | null): HeadersInit {
  // Só devolve allow-origin se a origem estiver na allowlist. Se a lista
  // estiver vazia (não configurada), aceita qualquer uma para não travar o
  // rollout — mas o Turnstile continua sendo a barreira principal.
  const permitido =
    ALLOWED_ORIGINS.length === 0 ||
    (origin !== null && ALLOWED_ORIGINS.includes(origin));
  return {
    "Access-Control-Allow-Origin": permitido && origin ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function normalizarTelefone(bruto: string): string {
  const digitos = (bruto ?? "").replace(/\D/g, "");
  return /^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos;
}

async function verificarTurnstile(
  token: string,
  ip: string | null,
): Promise<boolean> {
  if (!TURNSTILE_SECRET) return false;
  const form = new FormData();
  form.append("secret", TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    const data = await r.json();
    return data?.success === true;
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "METODO_INVALIDO" }, 405, origin);
  }

  // Camada secundária: origem na allowlist (não confie só nisso).
  if (
    ALLOWED_ORIGINS.length > 0 &&
    (origin === null || !ALLOWED_ORIGINS.includes(origin))
  ) {
    return json({ error: "ORIGEM_NAO_AUTORIZADA" }, 403, origin);
  }

  let corpo: Record<string, unknown>;
  try {
    corpo = await req.json();
  } catch {
    return json({ error: "JSON_INVALIDO" }, 400, origin);
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // 1) CAPTCHA — a barreira que derruba o bot
  const captchaOk = await verificarTurnstile(
    String(corpo.turnstileToken ?? ""),
    ip,
  );
  if (!captchaOk) {
    return json({ error: "CAPTCHA_INVALIDO" }, 403, origin);
  }

  // 2) Validação de entrada (espelha o formulário; o servidor não confia no client)
  const gira_id = String(corpo.gira_id ?? "").trim();
  const nome = String(corpo.nome ?? "").trim();
  const telefone = normalizarTelefone(String(corpo.telefone ?? ""));
  const email = String(corpo.email ?? "").trim();
  const observacoes = String(corpo.observacoes ?? "").trim();
  const primeira_visita = corpo.primeira_visita === true;

  if (!/^[0-9a-fA-F-]{36}$/.test(gira_id)) {
    return json({ error: "GIRA_INVALIDA" }, 400, origin);
  }
  if (nome.length < 2 || nome.length > LIMITES.nome || /[<>]/.test(nome)) {
    return json({ error: "NOME_INVALIDO" }, 400, origin);
  }
  if (!/^\d{10,11}$/.test(telefone)) {
    return json({ error: "TELEFONE_INVALIDO" }, 400, origin);
  }
  if (
    email &&
    (email.length > LIMITES.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
  ) {
    return json({ error: "EMAIL_INVALIDO" }, 400, origin);
  }
  if (observacoes.length > LIMITES.observacoes || /[<>]/.test(observacoes)) {
    return json({ error: "OBSERVACOES_INVALIDAS" }, 400, origin);
  }

  // 3) Insert com service role (ignora RLS; passa pelos triggers do banco)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const nomeNormalizado = nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const { error } = await admin.from("agendamentos").insert({
    gira_id,
    nome,
    nome_normalizado: nomeNormalizado,
    primeira_visita,
    observacoes: observacoes || null,
    telefone,
    email: email || null,
  });

  if (error) {
    const msg = `${error.message ?? ""} ${
      (error as { details?: string }).details ?? ""
    }`;
    const code = (error as { code?: string }).code ?? "";
    // Repassa os códigos dos triggers/índice para o front dar a mensagem certa
    if (msg.includes("CAPACIDADE_ATINGIDA")) {
      return json({ error: "CAPACIDADE_ATINGIDA" }, 409, origin);
    }
    if (msg.includes("GIRA_INATIVA") || msg.includes("GIRA_INEXISTENTE")) {
      return json({ error: "GIRA_INDISPONIVEL" }, 409, origin);
    }
    if (msg.includes("FLUXO_EXCEDIDO")) {
      return json({ error: "FLUXO_EXCEDIDO" }, 429, origin);
    }
    if (code === "23505") {
      return json({ error: "DUPLICADO" }, 409, origin);
    }
    console.error("insert falhou:", error);
    return json({ error: "ERRO_INTERNO" }, 500, origin);
  }

  return json({ ok: true }, 200, origin);
});
