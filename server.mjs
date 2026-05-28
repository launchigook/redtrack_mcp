import express from 'express';

const PROTOCOL_VERSION = '2024-11-05';
import { manifest } from './manifest.mjs';
import { runTool } from './redtrack.mjs';

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
});
