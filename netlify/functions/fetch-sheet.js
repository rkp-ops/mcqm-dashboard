const { GoogleAuth } = require('google-auth-library');
const zlib = require('zlib');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Encoding',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // Service account credentials from environment variable
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const sheetId = process.env.GOOGLE_SHEET_ID || '1LYAuIdgbARaJaI5KLBu8OSEsO4UsJfh-tnIXG0b5EQM';
    const sheetName = process.env.GOOGLE_SHEET_NAME || 'Sheet1';

    // Authenticate
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    // Fetch sheet data
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token.token}` },
    });

    if (!response.ok) {
      const err = await response.json();
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: err.error?.message || `Google API returned ${response.status}` }),
      };
    }

    const data = await response.json();

    // Trim trailing empty cells from each row to reduce payload size
    if (data.values) {
      data.values = data.values.map(row => {
        let lastNonEmpty = row.length - 1;
        while (lastNonEmpty >= 0 && (!row[lastNonEmpty] || row[lastNonEmpty] === '')) {
          lastNonEmpty--;
        }
        return row.slice(0, lastNonEmpty + 1);
      });
    }

    const jsonBody = JSON.stringify(data);

    // If payload is large, gzip compress it to fit under Netlify's 6MB limit
    if (jsonBody.length > 4_000_000) {
      const compressed = zlib.gzipSync(Buffer.from(jsonBody));
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Encoding': 'gzip',
          'Content-Type': 'application/json',
        },
        body: compressed.toString('base64'),
        isBase64Encoded: true,
      };
    }

    return {
      statusCode: 200,
      headers,
      body: jsonBody,
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
