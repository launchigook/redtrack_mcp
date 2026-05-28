/*
 * Model Context Protocol manifest generated at runtime.
 */
export const manifest = {
  schema_version: 'v0.6',
  name: 'redtrack_attribution',
  description: 'Query RedTrack conversions and campaigns',
  tools: [
    {
      name: 'ping',
      description: 'Health check. Returns \"pong\".',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'get_conversions',
      description: 'Return a list of conversions between two dates (YYYY-MM-DD)',
      input_schema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' }
        },
        required: ['startDate', 'endDate']
      }
    },
    {
      name: 'get_campaigns',
      description: 'Return all campaigns (optionally filtered by date_from / date_to). Handles pagination internally.',
      input_schema: {
        type: 'object',
        properties: {
          date_from: { type: 'string', format: 'date', description: 'optional start date' },
          date_to:   { type: 'string', format: 'date', description: 'optional end date' }
        },
        required: []
      }
    },
    {
      name: 'get_report',
      description: 'Aggregated RedTrack report grouped by one or more dimensions (e.g. sub3, sub6). Returns pre-aggregated stats per group (cost, conversions, revenue, profit, etc.) — fast and scoped. Use this instead of get_campaigns/get_conversions when you need per-creative/per-source performance for a specific campaign and date range.',
      input_schema: {
        type: 'object',
        properties: {
          group:       { type: 'string', description: 'Grouping dimension(s), comma-separated. e.g. "sub3,sub6"' },
          date_from:   { type: 'string', format: 'date', description: 'Start date YYYY-MM-DD' },
          date_to:     { type: 'string', format: 'date', description: 'End date YYYY-MM-DD' },
          timezone:    { type: 'string', description: 'Timezone, e.g. "America/New_York"' },
          campaign_id: { type: 'string', description: 'Filter by campaign id (comma-separated for multiple)' },
          source_id:   { type: 'string', description: 'Filter by source id' },
          offer_id:    { type: 'string', description: 'Filter by offer id' },
          sub1:  { type: 'string' }, sub2:  { type: 'string' }, sub3:  { type: 'string' },
          sub4:  { type: 'string' }, sub5:  { type: 'string' }, sub6:  { type: 'string' },
          sub7:  { type: 'string' }, sub8:  { type: 'string' }, sub9:  { type: 'string' },
          sub10: { type: 'string' },
          sortby:    { type: 'string', description: 'Sort by field, e.g. "profit"' },
          direction: { type: 'string', description: 'asc or desc' },
          total:     { type: 'boolean', description: 'Include total stats row' },
          per:       { type: 'integer', description: 'Page limit, max 1000' },
          page:      { type: 'integer', description: 'Page number' },
          fields:    { type: 'string', description: 'Comma-separated list of fields to include' }
        },
        required: ['group', 'date_from', 'date_to']
      }
    }
  ]
};
