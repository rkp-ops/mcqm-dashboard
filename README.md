# MCQM Live Ops Dashboard

Live operational dashboard that pulls from a Google Sheet (refreshed by Jira plugin) using a service account for authentication.

## Project Structure

```
mcqm-dashboard/
  netlify.toml          - Netlify config
  package.json          - Dependencies
  public/
    index.html          - The dashboard (frontend)
  netlify/functions/
    fetch-sheet.js      - Serverless function (authenticates + fetches sheet)
```

## Deploy to Netlify (Step by Step)

### 1. Create a Netlify account
Go to https://app.netlify.com/signup and sign up (free).

### 2. Install Netlify CLI
Open Terminal and run:
```
npm install -g netlify-cli
```

### 3. Deploy the site
In Terminal, navigate to the project folder and run:
```
cd mcqm-dashboard
npm install
netlify login
netlify init
```
When prompted:
- Choose "Create & configure a new site"
- Pick a team (your account)
- Give it a name like "mcqm-dashboard"

Then deploy:
```
netlify deploy --prod
```

### 4. Set Environment Variables
In the Netlify web dashboard (https://app.netlify.com):
1. Go to your site > Site settings > Environment variables
2. Add these two variables:

**GOOGLE_SERVICE_ACCOUNT_JSON**
Paste the ENTIRE contents of your service account JSON key file as the value.
(The full JSON blob starting with { and ending with })

**GOOGLE_SHEET_ID**
```
1LYAuIdgbARaJaI5KLBu8OSEsO4UsJfh-tnIXG0b5EQM
```

**GOOGLE_SHEET_NAME** (optional, defaults to Sheet1)
```
Sheet1
```

### 5. Redeploy after setting env vars
After adding the environment variables, redeploy:
```
netlify deploy --prod
```
Or just go to Deploys > Trigger deploy in the Netlify dashboard.

### 6. Verify
Visit your site URL (shown in Netlify dashboard). The dashboard should load with live data.

## Important: Rotate Your Service Account Key
If your service account JSON key was ever shared or exposed:
1. Go to Google Cloud Console > IAM & Admin > Service Accounts
2. Click your service account > Keys tab
3. Delete the old key
4. Create a new JSON key
5. Update the GOOGLE_SERVICE_ACCOUNT_JSON env variable in Netlify
6. Redeploy

## How It Works
- The HTML dashboard calls `/.netlify/functions/fetch-sheet`
- The serverless function authenticates with the service account
- It fetches the sheet data via Google Sheets API
- Returns the data to the dashboard
- All credentials stay server-side (never exposed to the browser)
- Dashboard auto-refreshes every 60 minutes
