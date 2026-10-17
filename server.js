// ════════════════════════════════════════════════════════════
//  WAFEO Digital Twin — local entry point
//  The app itself lives in server/ (see server/app.js).
// ════════════════════════════════════════════════════════════

const app = require('./server/app');
const config = require('./server/config');

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`\n  WAFEO Digital Twin API v2.1.0`);
    console.log(`  Running on http://localhost:${config.port}`);
    console.log(`  Session secret: ${config.jwtSecretSource}\n`);
  });
}

module.exports = app;
