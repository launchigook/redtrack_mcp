import express from 'express';

const PROTOCOL_VERSION = '2024-11-05';
import { manifest } from './manifest.mjs';
import { runTool, getReport } from './redtrack.mjs';

// ────────────────────────────────────────────────────────────────────────────
// Telegram auto-report scheduler
// Enabled when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars are set.
// Every REPORT_INTERVAL_MIN (default 15) minutes, pulls today's report for
// REPORT_CAMPAIGN_ID grouped by REPORT_GROUP and posts a compact summary.
// ────────────────────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
// Defaults pinned to the campaign + grouping the user actually wants reported.
// Override via Railway env vars if needed; set REPORT_CAMPAIGN_ID="" to disable filter.
const REPORT_CAMPAIGN_ID  = process.env.REPORT_CAMPAIGN_ID ?? '69ce350453a286805398f9a5';
const REPORT_GROUP        = process.env.REPORT_GROUP || 'sub3,sub6';
const REPORT_TIMEZONE     = process.env.REPORT_TIMEZONE || 'America/New_York';
const REPORT_INTERVAL_MIN = parseInt(process.env.REPORT_INTERVAL_MIN || '15', 10);
// Cap rows shown per section so the Telegram message stays under the 4096-char limit.
const REPORT_MAX_PER_SECTION = parseInt(process.env.REPORT_MAX_PER_SECTION || '10', 10);

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function trim(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function todayInTZ(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function timeInTZ(tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

async function sendTelegramReport() {
  try {
    const today = todayInTZ(REPORT_TIMEZONE);
    const args = {
      group: REPORT_GROUP,
      date_from: today,
      date_to: today,
      timezone: REPORT_TIMEZONE,
      sortby: 'profit',
      direction: 'desc'
    };
    if (REPORT_CAMPAIGN_ID) args.campaign_id = REPORT_CAMPAIGN_ID;
    const rows = await getReport(args);

    const list = Array.isArray(rows) ? rows : [];
    const num = v => Number(v) || 0;
    // Keep only rows with any meaningful activity — most campaigns have $0 spend
    // and 0 conv (e.g. organic-only) and would just be noise.
    const active = list.filter(r => num(r.cost) > 0 || num(r.conversions) > 0 || num(r.revenue) > 0);

    // Account-wide totals (across the active set).
    let tc = 0, tconv = 0, trev = 0, tprof = 0, tclk = 0;
    for (const r of active) {
      tc += num(r.cost); tconv += num(r.conversions); trev += num(r.revenue);
      tprof += num(r.profit); tclk += num(r.clicks);
    }
    const cpl = tconv ? tc / tconv : 0;
    const aov = tconv ? trev / tconv : 0;
    const roi = tc ? (tprof / tc) * 100 : 0;

    const profitable = active.filter(r => num(r.profit) > 0.005)
      .sort((a, b) => num(b.profit) - num(a.profit));
    const losses = active.filter(r => num(r.profit) < -0.005)
      .sort((a, b) => num(a.profit) - num(b.profit));

    // Render rows as a monospace <pre> table so columns line up in Telegram.
    const fitName = (s, w = 28) => {
      s = String(s || '(untagged)').trim();
      return s.length <= w ? s : s.slice(0, w - 1) + '…';
    };
    const money = (v, w = 8) => ((v >= 0 ? '+' : '') + `$${v.toFixed(2)}`).padStart(w);
    const padL = (s, w) => String(s).padStart(w);
    const nameFor = r => r.campaign || r.campaign_name || r.sub6 || r.sub3 || r.campaign_id || '';

    const renderTable = (arr) => {
      const head = `${'Profit'.padStart(9)} ${'Conv'.padStart(4)} ${'Spend'.padStart(8)} ${'CPL'.padStart(6)}  Creative`;
      const lines = [head, '─'.repeat(head.length)];
      const shown = arr.slice(0, REPORT_MAX_PER_SECTION);
      for (const r of shown) {
        const p = num(r.profit), c = num(r.cost), conv = num(r.conversions) | 0;
        const cplStr = conv ? `$${(c / conv).toFixed(2)}`.padStart(6) : '   — ';
        const spend = `$${c.toFixed(2)}`.padStart(8);
        const name = fitName(nameFor(r));
        lines.push(`${money(p, 9)} ${padL(conv, 4)} ${spend} ${cplStr}  ${name}`);
        const s3 = String(r.sub3 || ''), s6 = String(r.sub6 || '');
        if (s3 && s6 && s3 !== s6) {
          lines.push(`${' '.repeat(9 + 1 + 4 + 1 + 8 + 1 + 6 + 2)}└ ${s3}`);
        }
      }
      if (arr.length > shown.length) lines.push(`… +${arr.length - shown.length} aur`);
      return escapeHtml(lines.join('\n'));
    };

    const time = timeInTZ(REPORT_TIMEZONE);
    let msg;
    if (!active.length) {
      msg = `📊 ${today} ${time} ${REPORT_TIMEZONE}\nAbhi tak koi paid activity nahi today.`;
    } else {
      const sign = n => (n >= 0 ? '+' : '');
      const headerTitle = REPORT_CAMPAIGN_ID
        ? `Campaign ${REPORT_CAMPAIGN_ID.slice(0, 4)}…${REPORT_CAMPAIGN_ID.slice(-4)}`
        : 'All Campaigns';
      const totalsBlock =
        `Spend    ${('$' + tc.toFixed(2)).padStart(10)}\n` +
        `Conv     ${String(tconv | 0).padStart(10)}\n` +
        `Rev      ${('$' + trev.toFixed(2)).padStart(10)}\n` +
        `Profit   ${(sign(tprof) + '$' + tprof.toFixed(2)).padStart(10)}\n` +
        `ROI      ${(sign(roi) + roi.toFixed(0) + '%').padStart(10)}\n` +
        `CPL      ${('$' + cpl.toFixed(2)).padStart(10)}\n` +
        `AOV      ${('$' + aov.toFixed(2)).padStart(10)}`;

      msg  = `📊 <b>${escapeHtml(headerTitle)}</b> · ${today} ${time} ${REPORT_TIMEZONE}\n`;
      msg += `<pre>${escapeHtml(totalsBlock)}</pre>\n`;
      if (profitable.length) {
        msg += `🟢 <b>Profitable (${profitable.length})</b>\n<pre>${renderTable(profitable)}</pre>\n`;
      }
      if (losses.length) {
        msg += `🔴 <b>Loss — consider pausing (${losses.length})</b>\n<pre>${renderTable(losses)}</pre>`;
      }
    }
    // Telegram hard limit is 4096 chars; trim safely if we ever exceed.
    if (msg.length > 4000) msg = msg.slice(0, 3990) + '\n… (truncated)';

    const rsp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    if (!rsp.ok) {
      console.error('Telegram send failed:', rsp.status, (await rsp.text()).slice(0, 300));
    } else {
      console.log(`Telegram report sent: ${active.length} active campaigns, profit $${tprof.toFixed(2)}`);
    }
  } catch (err) {
    console.error('sendTelegramReport error:', err.message);
  }
}

function startReportScheduler() {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('Report scheduler disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set)');
    return;
  }
  console.log(`Report scheduler enabled: every ${REPORT_INTERVAL_MIN} min · campaign=${REPORT_CAMPAIGN_ID} · tz=${REPORT_TIMEZONE}`);
  setTimeout(sendTelegramReport, 10_000); // first run shortly after startup
  setInterval(sendTelegramReport, REPORT_INTERVAL_MIN * 60 * 1000);
}

// Helper to support both simple and JSON-RPC 2.0 payloads
// Full JSON-RPC + legacy processing
async function processRequest(body) {
    // If it's a JSON-RPC 2.0 payload
  if (body && body.jsonrpc === '2.0') {
    const id = body.id ?? null;
    switch (body.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {
                listChanged: false
              }
            },
            serverInfo: {
              name: 'redtrack_mcp',
              version: '1.0.0'
            }
          }
        };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: manifest.tools.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.input_schema
            }))
          }
        };
      case 'tools/call': {
        const { name, arguments: args = {} } = body.params ?? {};
        const { content } = await runTool({ tool: name, input: args });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: (content || []).map(txt => ({ type: 'text', text: typeof txt === 'string' ? txt : JSON.stringify(txt) }))
          }
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'notifications/initialized':
        // Client indicates initialization is complete - just acknowledge
        console.log('Client initialized - tools should now be available');
        return { jsonrpc: '2.0', id, result: {} };
      // Legacy wrapper for previous style
      case 'run': {
        const tool = body.params?.tool;
        const input = body.params?.input;
        const { content } = await runTool({ tool, input });
        return { jsonrpc: '2.0', id, result: { content } };
      }
      default:
        // Notifications (e.g. notifications/cancelled) carry no id and need no
        // result — acknowledge silently instead of erroring.
        if (typeof body.method === 'string' && body.method.startsWith('notifications/')) {
          console.log(`Acknowledged notification: ${body.method}`);
          return { jsonrpc: '2.0', id, result: {} };
        }
        throw new Error(`Unrecognised JSON-RPC method: ${body.method}`);
    }
  }

  // Non-JSON-RPC: simple payload { tool, input }
  const tool = body?.tool;
  const input = body?.input;
  const result = await runTool({ tool, input });
  return result;
}

const app = express();
app.use(express.json());

// MCP required endpoints
app.get('/manifest', (_, res) => {
  res.json(manifest);
});

app.post('/run', async (req, res) => {
  try {
    const result = await processRequest(req.body);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ isError: true, content: [err.message] });
  }
});

// Additional aliases for various IDE expectations
app.get('/', (_, res) => res.json(manifest));
app.post('/', async (req, res) => {
  try {
    const result = await processRequest(req.body);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ isError: true, content: [err.message] });
  }
});

// /mcp alias (e.g., bigquery example)
app.get('/mcp', (_, res) => res.json({
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: false },
    resources: {},
    prompts: {}
  },
  serverInfo: { name: 'redtrack_mcp', version: '1.0.0' },
  tools: manifest.tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema
  }))
}));
app.post('/mcp', async (req, res) => {
  try {
    console.log('POST /mcp received:', JSON.stringify(req.body, null, 2));

    // If body is empty or missing jsonrpc => return handshake object
    if (!req.body || !req.body.jsonrpc) {
      const response = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: {},
          prompts: {}
        },
        serverInfo: { name: 'redtrack_mcp', version: '1.0.0' }
      };
      console.log('Returning handshake:', JSON.stringify(response, null, 2));
      return res.json(response);
    }

    const result = await processRequest(req.body);
    console.log('Returning result:', JSON.stringify(result, null, 2));
    res.json(result);
  } catch (err) {
    console.error('Error in /mcp:', err);
    const errorResponse = {
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: err.message }
    };
    console.log('Returning error:', JSON.stringify(errorResponse, null, 2));
    res.status(500).json(errorResponse);
  }
});

// Nested /mcp/manifest and /mcp/run paths for IDE compatibility
app.get('/mcp/manifest', (_, res) => res.json(manifest));
app.post('/mcp/run', async (req, res) => {
  try {
    const result = await processRequest(req.body);
    const envelope = result.jsonrpc ? result : { jsonrpc: '2.0', id: req.body?.id ?? null, result };
    res.json(envelope);
  } catch (err) {
    console.error(err);
    res.status(500).json({ isError: true, content: [err.message] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RedTrack MCP server listening on port ${PORT}`);
  startReportScheduler();
});
