const { GoogleAuth } = require('google-auth-library');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
