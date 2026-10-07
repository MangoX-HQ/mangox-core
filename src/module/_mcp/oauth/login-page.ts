interface LoginPageParams {
  client_name: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  response_type: string;
  error?: string;
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderLoginPage(p: LoginPageParams): string {
  const e = escapeHtml;
  const errorBlock = p.error ? `<div class="err">${e(p.error)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Authorize ${e(p.client_name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0f17; color: #e8eaed; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #121826; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; width: 100%; max-width: 440px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
  h1 { margin: 0 0 8px 0; font-size: 22px; }
  .sub { color: #94a3b8; font-size: 14px; margin-bottom: 18px; }
  .scope { display: inline-block; background: #1e293b; color: #93c5fd; padding: 4px 10px; border-radius: 999px; font-size: 12px; margin-bottom: 18px; }
  .tabs { display: flex; gap: 6px; background: #0b1220; border: 1px solid #1f2937; border-radius: 10px; padding: 4px; margin-bottom: 18px; }
  .tab { flex: 1; text-align: center; padding: 8px 10px; font-size: 13px; color: #94a3b8; cursor: pointer; border-radius: 7px; user-select: none; }
  .tab.active { background: #1e293b; color: #e8eaed; }
  label { display: block; font-size: 13px; color: #cbd5e1; margin-bottom: 6px; margin-top: 12px; }
  input { width: 100%; padding: 10px 12px; background: #0b1220; border: 1px solid #1f2937; border-radius: 8px; color: #e8eaed; font-size: 14px; font-family: inherit; }
  input[name="api_key"] { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  input:focus { outline: none; border-color: #3b82f6; }
  button { width: 100%; margin-top: 22px; padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2563eb; }
  .err { background: #7f1d1d; color: #fecaca; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  .foot { text-align: center; color: #64748b; font-size: 12px; margin-top: 18px; }
  .foot a { color: #93c5fd; text-decoration: none; }
  .pane { display: none; }
  .pane.active { display: block; }
  .hint { color: #64748b; font-size: 12px; margin-top: 6px; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/oauth/authorize">
    <h1>Authorize ${e(p.client_name)}</h1>
    <div class="sub">Connect your MGS account to <strong>${e(p.client_name)}</strong>.</div>
    <div class="scope">scope: ${e(p.scope)}</div>
    ${errorBlock}

    <div class="tabs" role="tablist">
      <div class="tab active" data-pane="key" role="tab">API Key</div>
      <div class="tab" data-pane="pass" role="tab">Email / Password</div>
    </div>

    <div class="pane active" id="pane-key">
      <label for="api_key">MCP API Key</label>
      <input id="api_key" name="api_key" type="password" autocomplete="off" placeholder="mgs_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx" />
      <div class="hint">Generate one in your dashboard via <code>POST /api/v1/api-keys</code>. Each key is bound to one user/role.</div>
    </div>

    <div class="pane" id="pane-pass">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" />
    </div>

    <input type="hidden" name="client_id" value="${e(p.client_id)}" />
    <input type="hidden" name="redirect_uri" value="${e(p.redirect_uri)}" />
    <input type="hidden" name="state" value="${e(p.state)}" />
    <input type="hidden" name="code_challenge" value="${e(p.code_challenge)}" />
    <input type="hidden" name="code_challenge_method" value="${e(p.code_challenge_method)}" />
    <input type="hidden" name="scope" value="${e(p.scope)}" />
    <input type="hidden" name="response_type" value="${e(p.response_type)}" />
    <button type="submit">Authorize</button>
    <div class="foot">MGS MCP OAuth</div>
  </form>
  <script>
    (function () {
      var tabs = document.querySelectorAll('.tab');
      tabs.forEach(function (t) {
        t.addEventListener('click', function () {
          tabs.forEach(function (x) { x.classList.remove('active'); });
          t.classList.add('active');
          document.querySelectorAll('.pane').forEach(function (p) { p.classList.remove('active'); });
          document.getElementById('pane-' + t.getAttribute('data-pane')).classList.add('active');
        });
      });
    })();
  </script>
</body>
</html>`;
}
