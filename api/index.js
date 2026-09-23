// Vercel serverless entry — same Express app, no UI changes.
const app = require('../src/server');

// Keep under gateway kill; desk soft-fails briefing if budget tight.
module.exports = app;
module.exports.config = {
  maxDuration: 60,
  memory: 1024,
};
