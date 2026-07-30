// Loads the Google service-account JSON WITHOUT keeping it in an environment
// variable. Legacy Netlify/AWS Lambda caps the total size of env vars at 4KB,
// and the service-account key alone is ~2KB, which was breaking deploys.
//
// Resolution order:
//   1. process.env.GOOGLE_SERVICE_ACCOUNT_JSON   (fallback / local dev)
//   2. app_config table in Neon, key = 'google_service_account_json'
//
// Populate the DB once via the Neon SQL editor (see MIGRATION-app-config.sql),
// then delete the GOOGLE_SERVICE_ACCOUNT_JSON env var in Netlify to get back
// under the 4KB limit.

const { neon } = require('@neondatabase/serverless');

let _cached = null;
let _sql;
function sql() {
  if (!_sql) _sql = neon(process.env.NETLIFY_DATABASE_URL);
  return _sql;
}

// Returns the raw service-account JSON string (or null if not configured).
async function getServiceAccount() {
  if (_cached) return _cached;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    _cached = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    return _cached;
  }

  const rows = await sql()`
    SELECT value FROM app_config WHERE key = 'google_service_account_json' LIMIT 1
  `;
  _cached = rows && rows[0] ? rows[0].value : null;
  return _cached;
}

module.exports = { getServiceAccount };
