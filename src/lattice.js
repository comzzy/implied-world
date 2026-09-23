/**
 * Open Lattice — Monday cash-open rehearsal grid.
 * Rows: cash open move; columns: BTC residual shocks.
 * Optional wrapper bump applied uniformly (toggle on client).
 */

const { solve } = require('./solver');

const PLAIN = {
  ROOM_LEFT: 'Room left',
  NO_ROOM: 'No room',
  OPEN_BUT_UNSTABLE: 'Unstable',
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Adjust freeze for one lattice cell.
 * cashOpenMove: treated as wrapper/cash-gap shock on premium (decimal, e.g. -0.03).
 * residualShock: absolute BTC residual override (decimal), or additive if opts.residualMode === 'delta'.
 * wrapperBump: extra premium bump (decimal).
 */
function shockFreeze(freeze, { cashOpenMove = 0, residualShock = null, wrapperBump = 0, residualMode = 'absolute' } = {}) {
  const f = clone(freeze);
  const basePrem = num(freeze.premium?.value, 0);
  const baseRes = num(freeze.btc24hReturn?.value, 0);
  f.premium = {
    ...(f.premium || {}),
    value: basePrem + num(cashOpenMove) + num(wrapperBump),
  };
  let residual = baseRes;
  if (residualShock != null && Number.isFinite(Number(residualShock))) {
    residual = residualMode === 'delta' ? baseRes + num(residualShock) : num(residualShock);
  }
  f.btc24hReturn = { ...(f.btc24hReturn || {}), value: residual };
  return f;
}

/**
 * @param {object} freeze
 * @param {{ cashOpens?: number[], residualShocks?: number[], wrapperBumps?: number[], stressPad?: number }} opts
 *   cashOpens / residualShocks / wrapperBumps are decimals (0.01 = 1%).
 *   If wrapperBumps omitted or empty, uses [0].
 */
function runLattice(freeze, opts = {}) {
  if (!freeze) throw new Error('freeze required');

  const cashOpens =
    Array.isArray(opts.cashOpens) && opts.cashOpens.length
      ? opts.cashOpens.map((x) => num(x))
      : [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03];

  const residualShocks =
    Array.isArray(opts.residualShocks) && opts.residualShocks.length
      ? opts.residualShocks.map((x) => num(x))
      : [-0.03, 0, 0.03];

  const wrapperBumps =
    Array.isArray(opts.wrapperBumps) && opts.wrapperBumps.length
      ? opts.wrapperBumps.map((x) => num(x))
      : [0];

  const stressPad = opts.stressPad != null ? num(opts.stressPad, undefined) : undefined;
  const solveOpts = stressPad != null ? { stressPad } : {};

  const grids = wrapperBumps.map((wrapperBump) => {
    const rows = cashOpens.map((cashOpen) => {
      const cells = residualShocks.map((residual) => {
        const shocked = shockFreeze(freeze, {
          cashOpenMove: cashOpen,
          residualShock: residual,
          wrapperBump,
          residualMode: 'absolute',
        });
        const band = solve(shocked, solveOpts);
        return {
          cashOpen,
          residual,
          wrapperBump,
          status: band.status,
          plain: PLAIN[band.status] || band.status,
          mid: band.implied_gap_mid,
          lo: band.implied_gap_lo,
          hi: band.implied_gap_hi,
          premium: band.premium,
        };
      });
      return { cashOpen, cells };
    });
    return { wrapperBump, rows };
  });

  return {
    cashOpens,
    residualShocks,
    wrapperBumps,
    grids,
    // Convenience: first (or only) grid as primary
    grid: grids[0],
    plain_map: PLAIN,
    note: 'Cash-open move is applied as a premium/wrapper gap shock. Residual columns set BTC residual. Human decides.',
  };
}

module.exports = { runLattice, shockFreeze, PLAIN };
