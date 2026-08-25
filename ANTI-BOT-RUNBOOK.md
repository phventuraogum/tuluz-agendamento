# Anti-bot no agendamento (Turnstile + Edge Function)

Fecha o bypass do site apontado no pentest (F1/F2): hoje um script agenda direto
na API do Supabase sem abrir a página. A partir daqui, toda escrita passa por uma
Edge Function que exige um CAPTCHA (Cloudflare Turnstile) e insere com service
role — e o INSERT direto do público é revogado.

O rollout foi desenhado para **não quebrar nada** enquanto você não terminar:
enquanto `VITE_TURNSTILE_SITE_KEY` não estiver definida no site, o formulário
continua no fluxo direto atual. O anti-bot só entra em ação quando você concluir
os passos abaixo.

## Passo a passo (na ordem)

1. **Criar as chaves do Turnstile (grátis, ~2 min)**
   - Cloudflare Dashboard → **Turnstile** → *Add site*.
   - Domínios: `tuluz-agendamento.vercel.app` (e o domínio próprio, se houver).
   - Widget mode: **Managed**. Copie a **Site Key** (pública) e a **Secret Key**.

2. **Configurar os segredos da Edge Function no Supabase**
   Dashboard → **Edge Functions** → *Manage secrets* (ou via CLI):
   ```
   supabase secrets set TURNSTILE_SECRET=<sua-secret-key>
   supabase secrets set ALLOWED_ORIGINS=https://tuluz-agendamento.vercel.app
   ```
   (`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetados pelo Supabase.)

3. **Publicar a função**
   ```
   supabase functions deploy agendar
   ```
   Ela vive em `supabase/functions/agendar/index.ts`.

4. **Definir a Site Key no site (Vercel)**
   Project → Settings → **Environment Variables**:
   ```
   VITE_TURNSTILE_SITE_KEY = <sua-site-key>
   ```
   Redeploy. Agora o formulário mostra o desafio e envia pela função.

5. **Testar** o agendamento pelo site (deve aparecer o Turnstile e concluir).

6. **Fechar a porta**: rodar `supabase_revogar_insert_anon.sql` no SQL Editor.
   A partir daqui, script que fale direto com a API recebe *permission denied*.

## Rollback

- Reabrir escrita direta: `GRANT INSERT ON agendamentos TO anon;`
- Desligar o anti-bot no site: remover `VITE_TURNSTILE_SITE_KEY` e redeploy.

## Observações

- O CAPTCHA é a barreira que derruba o bot. A allowlist de origem é camada
  secundária (cabeçalho é forjável fora do navegador).
- Os triggers do banco (gira ativa, capacidade, freio de vazão, dedupe)
  continuam valendo — a função insere passando por todos eles.
- Rate limit adicional por IP pode ser somado depois; o Turnstile já cobre o
  grosso do abuso.
