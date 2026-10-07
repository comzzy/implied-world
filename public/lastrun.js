/* Last real live run (stored server-side after a successful Desk run). No sample data. */
(function () {
  function fmtWat(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    const date = d.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false });
    return date + ', ' + time + ' WAT';
  }

  function label(parsed) {
    const f = (parsed && parsed.freeze) || {};
    return 'Last live run · ' + (parsed.symbol || f.symbol || '—') + ' · ' + fmtWat(f.asOf || parsed.at);
  }

  async function fetchStored(symbol) {
    try {
      const r = await fetch('/api/last-run?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.ok && j.freeze ? j : null;
    } catch (_) {
      return null;
    }
  }

  function remember(data) {
    const payload = JSON.stringify({
      freeze: data.freeze,
      band: data.band,
      symbol: data.symbol || data.freeze.symbol,
      at: data.freeze.asOf,
      lastRun: true,
    });
    let ok = false;
    try { localStorage.setItem('iw:lastFreeze', payload); ok = true; } catch (_) {}
    try { sessionStorage.setItem('iw:lastFreeze', payload); ok = true; } catch (_) {}
    return ok;
  }

  /** Pull the stored run for symbol into browser storage; true if found. */
  async function pull(symbol) {
    const data = await fetchStored(symbol);
    return data ? remember(data) : false;
  }

  window.IWLastRun = { fmtWat, label, fetchStored, remember, pull };
})();
