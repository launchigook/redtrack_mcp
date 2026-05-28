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
// REPORT_CAMPAIGN_ID is optional now — leave empty to report ALL campaigns.
const REPORT_CAMPAIGN_ID  = process.env.REPORT_CAMPAIGN_ID || '';
const REPORT_GROUP        = process.env.REPORT_GROUP || 'campaign';
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

    // Row label: prefer campaign name; fall back to sub6/sub3/campaign_id for other groupings.
    const label = r => escapeHtml(trim(
      r.campaign || r.campaign_name || r.sub6 || r.sub3 || r.campaign_id || '(untagged)',
      55
    ));
    const rowLine = (r) => {
      const p = num(r.profit), c = num(r.cost), conv = num(r.conversions);
      const sign = p >= 0 ? '+' : '';
      const cplStr = conv ? ` · CPL $${(c / conv).toFixed(2)}` : '';
      let line = `• ${label(r)}: <b>$${sign}${p.toFixed(2)}</b> ($${c.toFixed(2)} · ${conv | 0} conv${cplStr})`;
      // Append the sub3 (source platform campaign/ad id) below the row when both
      // sub3 and sub6 are present and distinct — useful when grouping by sub3,sub6.
      if (r.sub3 && r.sub6 && r.sub3 !== r.sub6) {
        line += `\n   <code>sub3: ${escapeHtml(r.sub3)}</code>`;
      }
      return line;
    };
    const renderSection = (title, arr) => {
      if (!arr.length) return '';
      const shown = arr.slice(0, REPORT_MAX_PER_SECTION);
      const extra = arr.length - shown.length;
      let s = `\n${title} (${arr.length})\n` + shown.map(rowLine).join('\n');
      if (extra > 0) s += `\n… +${extra} aur`;
      return s + '\n';
    };

    const time = timeInTZ(REPORT_TIMEZONE);
    let msg;
    if (!active.length) {
      msg = `📊 ${today} ${time} ${REPORT_TIMEZONE}\nAbhi tak koi paid activity nahi today.`;
    } else {
      const sign = n => (n >= 0 ? '+' : '');
      const emoji = tprof >= 0 ? '🟢' : '🔴';
      msg  = `📊 <b>All Campaigns</b> · ${today} ${time} ${REPORT_TIMEZONE}\n`;
      msg += `<b>Account:</b> spend $${tc.toFixed(2)} · conv ${tconv | 0} · rev $${trev.toFixed(2)}\n`;
      msg += `${emoji} Profit <b>$${sign(tprof)}${tprof.toFixed(2)}</b> · ROI ${sign(roi)}${roi.toFixed(0)}% · CPL $${cpl.toFixed(2)} · AOV $${aov.toFixed(2)}\n`;
      msg += renderSection('🟢 <b>Profitable</b>', profitable);
      msg += renderSection('🔴 <b>Loss — consider pausing</b>', losses);
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
