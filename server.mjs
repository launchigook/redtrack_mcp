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

// ── Auto-pause config ──────────────────────────────────────────────────────
// Pauses creatives that bleed without converting. Rule:
//   today spend ≥ PAUSE_MIN_SPEND  AND
//   today conversions == 0          AND
//   active for ≥ PAUSE_MIN_HOURS    (derived from RedTrack hour_of_day)
// When PAUSE_DRY_RUN=true (default), it only sends a "WOULD PAUSE" Telegram
// alert instead of actually pausing — useful to validate the rule first.
const PAUSE_ENABLED   = process.env.PAUSE_ENABLED === 'true';
const PAUSE_DRY_RUN   = process.env.PAUSE_DRY_RUN !== 'false';
const PAUSE_MIN_SPEND = parseFloat(process.env.PAUSE_MIN_SPEND || '5');
const PAUSE_MIN_HOURS = parseInt(process.env.PAUSE_MIN_HOURS || '2', 10);
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN || '';
const FB_API_VERSION  = process.env.FB_API_VERSION || 'v18.0';

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
    const nameFor = r => r.campaign || r.campaign_name || r.sub6 || r.sub3 || r.campaign_id || '';

    // Build the per-row text lines for a set of campaigns/creatives. Each row
    // is one main line plus an optional sub3 sub-line.
    const buildRowLines = (arr) => {
      const out = [];
      for (const r of arr) {
        const p = num(r.profit), c = num(r.cost), rev = num(r.revenue), conv = num(r.conversions) | 0;
        const spendStr = `$${c.toFixed(2)}`.padStart(8);
        const revStr   = `$${rev.toFixed(2)}`.padStart(8);
        const cplStr   = conv ? `$${(c / conv).toFixed(2)}`.padStart(6) : '   — ';
        const aovStr   = conv ? `$${(rev / conv).toFixed(2)}`.padStart(6) : '   — ';
        out.push(`${money(p, 9)} ${String(conv).padStart(4)} ${spendStr} ${revStr} ${cplStr} ${aovStr}  ${fitName(nameFor(r))}`);
        const s3 = String(r.sub3 || ''), s6 = String(r.sub6 || '');
        if (s3 && s6 && s3 !== s6) {
          // Indent the sub3 sub-line under the Creative column.
          // Column widths: Profit(9)+1 Conv(4)+1 Spend(8)+1 Rev(8)+1 CPL(6)+1 AOV(6)+2 → 48
          out.push(`${' '.repeat(48)}└ ${s3}`);
        }
      }
      return out;
    };

    // Telegram sendMessage helper — POSTs one message, logs failures.
    const tgSend = async (text) => {
      const rsp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
      });
      if (!rsp.ok) console.error('Telegram send failed:', rsp.status, (await rsp.text()).slice(0, 300));
      return rsp.ok;
    };

    // Send a section's rows as one or more <pre> messages, splitting at row
    // boundaries when the per-message char budget would be exceeded.
    const COLUMN_HEADER = `   Profit Conv    Spend      Rev    CPL    AOV  Creative`;
    const COLUMN_SEP    = '─'.repeat(COLUMN_HEADER.length);
    const MSG_BUDGET    = 3800; // leave headroom under Telegram's 4096-char cap
    const sendSection = async (titleHTML, rowLines, totalCount) => {
      if (!rowLines.length) return;
      const wrap = (titleSuffix, body) =>
        `${titleHTML}${titleSuffix}\n<pre>${escapeHtml(COLUMN_HEADER)}\n${COLUMN_SEP}\n${escapeHtml(body)}</pre>`;
      // Greedy pack rows into chunks. We pre-compute the empty wrap length so we
      // know the per-chunk overhead and can decide when to flush.
      const overhead = wrap(` (part ?/?)`, '').length;
      const maxBody = MSG_BUDGET - overhead;
      const chunks = [];
      let buf = [], bufLen = 0;
      for (const ln of rowLines) {
        const add = ln.length + 1; // +1 for newline
        if (bufLen + add > maxBody && buf.length) {
          chunks.push(buf.join('\n'));
          buf = []; bufLen = 0;
        }
        buf.push(ln); bufLen += add;
      }
      if (buf.length) chunks.push(buf.join('\n'));
      for (let i = 0; i < chunks.length; i++) {
        const suffix = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : '';
        await tgSend(wrap(suffix, chunks[i]));
      }
    };

    const time = timeInTZ(REPORT_TIMEZONE);
    if (!active.length) {
      await tgSend(`📊 ${today} ${time} ${REPORT_TIMEZONE}\nAbhi tak koi paid activity nahi today.`);
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

      // Header + totals as the first message.
      await tgSend(
        `📊 <b>${escapeHtml(headerTitle)}</b> · ${today} ${time} ${REPORT_TIMEZONE}\n` +
        `<pre>${escapeHtml(totalsBlock)}</pre>`
      );
      // Then every profitable creative (split across messages if needed).
      await sendSection(`🟢 <b>Profitable (${profitable.length})</b>`, buildRowLines(profitable), profitable.length);
      // Then every loss creative.
      await sendSection(`🔴 <b>Loss — consider pausing (${losses.length})</b>`, buildRowLines(losses), losses.length);
    }
    console.log(`Telegram report sent: ${active.length} rows (prof ${profitable.length}, loss ${losses.length}), profit $${tprof.toFixed(2)}`);
  } catch (err) {
    console.error('sendTelegramReport error:', err.message);
  }
}

// ── Auto-pause implementation ───────────────────────────────────────────────
// In-memory dedupe: per-day set of sub3 IDs we've already paused this UTC date.
// Resets when REPORT_TIMEZONE day rolls over. Resets on container restart too,
// but FB pause is idempotent so worst case we re-issue a pause for an already-
// paused campaign (which FB accepts as a no-op).
const _pausedToday = new Set();
let _pausedDate = '';

// Lightweight tgPost — module-level helper used by auto-pause alerts.
async function tgPost(text) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    const rsp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    if (!rsp.ok) console.error('tgPost failed:', rsp.status, (await rsp.text()).slice(0, 200));
    return rsp.ok;
  } catch (e) { console.error('tgPost error:', e.message); return false; }
}

// Pause an FB campaign via Marketing API.
async function fbPauseCampaign(campaignId) {
  if (!FB_ACCESS_TOKEN) throw new Error('FB_ACCESS_TOKEN not set');
  const body = new URLSearchParams({ status: 'PAUSED', access_token: FB_ACCESS_TOKEN });
  const rsp = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${encodeURIComponent(campaignId)}`, {
    method: 'POST', body
  });
  if (!rsp.ok) {
    const t = await rsp.text();
    throw new Error(`FB ${rsp.status}: ${t.slice(0, 200)}`);
  }
  return rsp.json();
}

// Determine how many hours a sub3 has been active today via RedTrack hour_of_day.
async function getHoursActiveToday(sub3, today) {
  try {
    const rows = await getReport({
      group: 'hour_of_day',
      date_from: today, date_to: today,
      campaign_id: REPORT_CAMPAIGN_ID,
      sub3,
      timezone: REPORT_TIMEZONE
    });
    if (!Array.isArray(rows) || !rows.length) return 0;
    const hoursWithSpend = rows
      .filter(r => Number(r.cost) > 0)
      .map(r => parseInt(r.hour_of_day, 10))
      .filter(h => !isNaN(h));
    if (!hoursWithSpend.length) return 0;
    const firstHour = Math.min(...hoursWithSpend);
    const nowHourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: REPORT_TIMEZONE, hour: '2-digit', hour12: false
    }).format(new Date());
    const currentHour = parseInt(nowHourStr, 10);
    return Math.max(0, currentHour - firstHour + 1);
  } catch (e) {
    console.error('getHoursActiveToday error:', e.message);
    return 0;
  }
}

async function runAutoPause() {
  if (!PAUSE_ENABLED) return;
  const today = todayInTZ(REPORT_TIMEZONE);
  if (today !== _pausedDate) { _pausedToday.clear(); _pausedDate = today; }

  let rows;
  try {
    rows = await getReport({
      group: 'sub3,sub6',
      date_from: today, date_to: today,
      campaign_id: REPORT_CAMPAIGN_ID,
      timezone: REPORT_TIMEZONE,
      sortby: 'profit', direction: 'asc'
    });
  } catch (e) {
    console.error('auto-pause report fetch failed:', e.message);
    return;
  }
  const num = v => Number(v) || 0;
  const candidates = (Array.isArray(rows) ? rows : []).filter(r =>
    num(r.cost) >= PAUSE_MIN_SPEND && num(r.conversions) === 0 && r.sub3
  );

  const actions = [];
  for (const r of candidates) {
    const sub3 = String(r.sub3);
    if (_pausedToday.has(sub3)) continue;
    const hours = await getHoursActiveToday(sub3, today);
    const cost = num(r.cost);
    const name = trim(String(r.sub6 || r.sub3 || '(untagged)'), 50);
    if (hours < PAUSE_MIN_HOURS) {
      actions.push({ sub3, name, status: 'SKIP', reason: `active ${hours}h < ${PAUSE_MIN_HOURS}h`, cost });
      continue;
    }
    if (PAUSE_DRY_RUN || !FB_ACCESS_TOKEN) {
      const why = !FB_ACCESS_TOKEN && !PAUSE_DRY_RUN ? '(no FB token set → forced dry-run)' : '';
      actions.push({ sub3, name, status: 'WOULD-PAUSE', reason: `spend $${cost.toFixed(2)}, 0 conv, active ${hours}h ${why}`, cost });
    } else {
      try {
        await fbPauseCampaign(sub3);
        _pausedToday.add(sub3);
        actions.push({ sub3, name, status: 'PAUSED', reason: `spend $${cost.toFixed(2)}, 0 conv, active ${hours}h`, cost });
      } catch (e) {
        actions.push({ sub3, name, status: 'ERROR', reason: e.message, cost });
      }
    }
  }
  if (!actions.length) return;

  const time = timeInTZ(REPORT_TIMEZONE);
  const head = (PAUSE_DRY_RUN || !FB_ACCESS_TOKEN)
    ? `🤖 <b>Auto-pause check</b> · ${today} ${time}\n<i>DRY-RUN mode — no actual pauses</i>`
    : `🤖 <b>Auto-pause</b> · ${today} ${time}`;
  const icon = s => ({ PAUSED: '🛑', 'WOULD-PAUSE': '🟡', SKIP: '⏭️', ERROR: '⚠️' }[s] || '•');
  const lines = actions.map(a =>
    `${icon(a.status)} <b>${a.status}</b>: ${escapeHtml(a.name)}\n   ${escapeHtml(a.reason)}\n   <code>sub3: ${escapeHtml(a.sub3)}</code>`
  );
  await tgPost(`${head}\n\n${lines.join('\n')}`);
  console.log(`Auto-pause: ${actions.length} actions (${actions.filter(a => a.status === 'PAUSED').length} paused, ${actions.filter(a => a.status === 'WOULD-PAUSE').length} would-pause, ${actions.filter(a => a.status === 'SKIP').length} skipped)`);
}

function startReportScheduler() {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('Report scheduler disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set)');
    return;
  }
  console.log(`Report scheduler enabled: every ${REPORT_INTERVAL_MIN} min · campaign=${REPORT_CAMPAIGN_ID} · tz=${REPORT_TIMEZONE}`);
  setTimeout(sendTelegramReport, 10_000); // first run shortly after startup
  setInterval(sendTelegramReport, REPORT_INTERVAL_MIN * 60 * 1000);

  if (PAUSE_ENABLED) {
    const mode = (PAUSE_DRY_RUN || !FB_ACCESS_TOKEN) ? 'DRY-RUN' : 'LIVE';
    console.log(`Auto-pause enabled (${mode}): spend ≥ $${PAUSE_MIN_SPEND}, 0 conv, ≥ ${PAUSE_MIN_HOURS}h active`);
    setTimeout(runAutoPause, 25_000); // staggered shortly after first report
    setInterval(runAutoPause, REPORT_INTERVAL_MIN * 60 * 1000);
  } else {
    console.log('Auto-pause disabled (set PAUSE_ENABLED=true on Railway to enable)');
  }
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
