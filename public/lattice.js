/* Open Lattice — next cash open check for overnight rToken theses. Live desk freeze only. */
(function () {
  const $ = (id) => document.getElementById(id);

  function renderDqBadge(freeze) {
    const el = $('dqBadge');
    if (!el || !freeze) {
      if (el) el.hidden = true;
      return;
    }
    const fields = [
      ['cash', freeze.cashClose?.tag],
      ['rToken', freeze.rtoken?.tag],
      ['hours', (freeze.hoursToCashOpen || freeze.hoursToOpen)?.tag],
      ['BTC move', freeze.btc24hReturn?.tag],
      ['event', freeze.eventClass?.tag],
      ['book', freeze.bookSpread?.tag],
    ].filter((x) => x[1]);
    if (!fields.length) {
      el.hidden = true;
      return;
    }
    const plain = (tag) =>
      tag === 'observed' || tag === 'computed'
        ? tag === 'computed'
          ? 'Computed'
          : 'Observed'
        : tag === 'source_failed'
          ? 'Failed'
          : 'Assumed';
    el.hidden = false;
    el.innerHTML =
      '<span>Last freeze quality · <a href="/">Desk</a></span> ' +
      fields
        .map(([label, tag]) => {
          const cls = tag === 'source_failed' ? 'source_failed' : tag;
          return `<span>${label} <span class="dq-pill ${cls}">${plain(tag)}</span></span>`;
        })
        .join(' ');
  }

  function showFail(err, data, res) {
    const kind = (data && data.failureKind) || classifyClientFail(err, res);
    const msg =
      (data && (data.failureMessage || data.error)) ||
      (err && err.message) ||
      'Unknown failure';
    $('metaLine').innerHTML =
      '<span class="fail-banner"><span class="fail-kind">' +
      esc(kind) +
      '</span>' +
      esc(humanFail(kind, msg)) +
      '</span>';
  }

  function classifyClientFail(err, res) {
    const m = String((err && err.message) || '');
    if (/Failed to fetch|NetworkError|offline/i.test(m)) return 'network';
    if (res && res.status === 504) return 'timeout';
    if (res && res.status >= 400) return 'api';
    if (/timeout|timed out/i.test(m)) return 'timeout';
    return 'server';
  }

  function humanFail(kind, msg) {
    const head =
      kind === 'network'
        ? 'Server failed — network.'
        : kind === 'api'
          ? 'Server failed — API.'
          : kind === 'timeout'
            ? 'Server failed — timeout.'
            : kind === 'missing_data'
              ? 'Server failed — missing data.'
              : kind === 'writeup'
                ? 'Writeup failed — numbers may still be OK.'
                : 'Server failed.';
    return (
      head +
      ' ' +
      String(msg || '')
        .replace(/^Server failed[^.]*\.?\s*/i, '')
        .slice(0, 160)
    );
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  let freeze = null;
  let from = 'none';

  const STATUS_CLASS = {
    ROOM_LEFT: 'cell-room',
    NO_ROOM: 'cell-no-room',
    OPEN_BUT_UNSTABLE: 'cell-unstable',
  };
  const PLAIN = {
    ROOM_LEFT: 'Room left',
    NO_ROOM: 'No room',
    OPEN_BUT_UNSTABLE: 'Unstable',
  };

  function pctLabel(x) {
    const n = Number(x) * 100;
    return (n >= 0 ? '+' : '') + n.toFixed(0) + '%';
  }

  function clearGrid() {
    const thead = $('latticeTable').querySelector('thead');
    const tbody = $('latticeTable').querySelector('tbody');
    if (thead) thead.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
  }

  function emptyState(msg) {
    freeze = null;
    from = 'none';
    clearGrid();
    const dq = $('dqBadge');
    if (dq) dq.hidden = true;
    $('metaLine').textContent =
      msg ||
      'No last desk freeze. Run the Desk first, then Load last freeze.';
  }

  function loadLastFreeze() {
    try {
      let raw = null;
      try { raw = localStorage.getItem('iw:lastFreeze'); } catch (_) {}
      if (!raw) {
        try { raw = sessionStorage.getItem('iw:lastFreeze'); } catch (_) {}
      }
      if (!raw) {
        emptyState(
          'No last desk freeze. Run the Desk first, then Load last freeze.'
        );
        return false;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.freeze) {
        emptyState(
          'Last desk payload missing freeze. Run the Desk again, then Load last freeze.'
        );
        return false;
      }
      freeze = parsed.freeze;
      from = 'desk';
      if (parsed.symbol) $('symbol').value = parsed.symbol;
      $('metaLine').textContent =
        'Loaded desk freeze · ' +
        (parsed.symbol || freeze.symbol) +
        ' · saved ' +
        (parsed.at || '—');
      renderDqBadge(freeze);
      return true;
    } catch (err) {
      showFail(err);
      return false;
    }
  }

  async function runLattice() {
    try {
      if (!freeze) {
        emptyState(
          'No freeze loaded. Run the Desk first, then Load last freeze.'
        );
        return;
      }
      const want = $('symbol').value;
      if (freeze.symbol && freeze.symbol !== want) {
        emptyState(
          'Loaded freeze is for ' +
            freeze.symbol +
            ', not ' +
            want +
            '. Run Desk for ' +
            want +
            ' or Load last freeze that matches.'
        );
        return;
      }

      const wrapperBumps = $('wrapBump').checked ? [0.01] : [0];
      const body = {
        freeze,
        cashOpens: [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03],
        residualShocks: [-0.03, 0, 0.03],
        wrapperBumps,
      };
      let r;
      try {
        r = await fetch('/api/lattice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        showFail(err);
        return;
      }
      const j = await r.json().catch(() => ({
        ok: false,
        error: r.statusText,
        failureKind: 'api',
      }));
      if (!j.ok) {
        showFail(null, j, r);
        return;
      }
      renderGrid(j);
      renderDqBadge(freeze);
      const bump = $('wrapBump').checked ? ' · wrapper bump +1%' : '';
      $('metaLine').textContent =
        'Lattice · ' +
        (j.symbol || freeze.symbol) +
        ' · desk freeze' +
        bump;
    } catch (err) {
      showFail(err);
    }
  }

  function renderGrid(data) {
    const grid = data.grid || (data.grids && data.grids[0]);
    if (!grid) return;
    const residuals = data.residualShocks || [-0.03, 0, 0.03];
    const thead = $('latticeTable').querySelector('thead');
    const tbody = $('latticeTable').querySelector('tbody');

    thead.innerHTML =
      '<tr><th class="row-h">Stock open \\\\ BTC move</th>' +
      residuals.map((r) => '<th>BTC ' + pctLabel(r) + '</th>').join('') +
      '</tr>';

    tbody.innerHTML = (grid.rows || [])
      .map((row) => {
        const cells = (row.cells || [])
          .map((c) => {
            const cls = STATUS_CLASS[c.status] || '';
            const plain = c.plain || PLAIN[c.status] || c.status;
            return '<td class="' + cls + '">' + plain + '</td>';
          })
          .join('');
        return (
          '<tr class="arrive-on"><th class="row-h">' +
          pctLabel(row.cashOpen) +
          '</th>' +
          cells +
          '</tr>'
        );
      })
      .join('');
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      tbody.querySelectorAll('tr').forEach((tr) => tr.classList.remove('arrive-on'));
    }
  }

  $('loadLast').addEventListener('click', () => {
    if (loadLastFreeze()) runLattice();
  });
  $('runLattice').addEventListener('click', () => runLattice());
  $('symbol').addEventListener('change', () => {
    const want = $('symbol').value;
    if (!freeze || (freeze.symbol && freeze.symbol !== want)) {
      emptyState(
        'Symbol changed to ' +
          want +
          '. Load a matching last desk freeze (or run Desk for ' +
          want +
          ').'
      );
      return;
    }
    runLattice();
  });
  $('wrapBump').addEventListener('change', () => {
    if (freeze) runLattice();
  });

  if (loadLastFreeze()) {
    runLattice().catch((e) => showFail(e));
  }
})();
