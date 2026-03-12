// FILE: relay.js
// Purpose: Re-exports the shared relay core for standalone relay tooling inside the monorepo.
// Layer: Standalone server module
// Exports: setupRelay, getRelayStats

module.exports = require("../phodex-bridge/src/relay-core");
