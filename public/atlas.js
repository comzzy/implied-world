/* Atlas — does one overnight rToken shock hit only one name or many? */
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

  function pct(x) {
    if (x == null || !Number.isFinite(Number(x))) return 'n/a';
    return (Number(x) * 100).toFixed(2) + '%';
  }

  let deskFreeze = null;
  let mode = 'sample';

  const PILL = {
    ROOM_LEFT: 'room',
    NO_ROOM: 'no-room',
    OPEN_BUT_UNSTABLE: 'unstable',
  };

  function loadLastFreeze() {
    try {
      const raw = localStorage.getItem('iw:lastFreeze');
      if (!raw) {
        $('metaLine').textContent =
          'No last desk freeze. Sample for all three names.';
        return false;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.freeze) return false;
      deskFreeze = parsed.freeze;
      mode = 'desk';
      if (parsed.symbol) $('sourceSymbol').value = parsed.symbol;
      $('metaLine').textContent =
        'Will blend desk freeze for ' +
        (parsed.symbol || deskFreeze.symbol) +
        ' with samples for peers.';
      renderDqBadge(deskFreeze);
      return true;
    } catch (err) {
      showFail(err);
      return false;
    }
  }

  async function runAtlas() {
    const body = {
      sourceSymbol: $('sourceSymbol').value,
      shockType: $('shockType').value,
      useSample: mode !== 'desk',
    };
    if (mode === 'desk' && deskFreeze) {
      body.freeze = deskFreeze;
      body.useSample = false;
    }

    let r;
    try {
      r = await fetch('/api/atlas', {
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
    render(j);
    if (deskFreeze) renderDqBadge(deskFreeze);
  }

  function render(data) {
    const heat = $('heat');
    heat.innerHTML = (data.symbols || ['NVDA', 'TSLA', 'AAPL'])
      .map((sym) => {
        const c = (data.cells && data.cells[sym]) || {};
        const base = (data.baseline && data.baseline[sym]) || {};
        const pill = PILL[c.status] || '';
        const flipped = c.flipped ? ' flipped' : '';
        const src = c.is_source ? '<span class="src-tag">starting</span>' : '';
        return (
          '<div class="atlas-cell' +
          flipped +
          '">' +
          '<p class="sym">' +
          sym +
          src +
          '</p>' +
          '<span class="status-pill ' +
          pill +
          '">' +
          (c.plain || c.status || '—') +
          '</span>' +
          '<div class="mid">' +
          'range middle ' +
          pct(c.mid) +
          '<br />was ' +
          pct(base.mid) +
          ' · ' +
          (base.plain || base.status || '—') +
          '</div>' +
          '</div>'
        );
      })
      .join('');

    const callout = $('breakCallout');
    callout.hidden = false;
    const kind = data.breakKind || 'none';
    $('breakLabel').textContent =
      kind === 'single_name'
        ? 'Single-name break'
        : kind === 'factor'
          ? 'Factor break'
          : 'No break';
    $('breakPlain').textContent = data.breakPlain || '';

    const src =
      data.fromSample || data.useSample ? 'sample' : 'mixed/live';
    const flips = data.flipCount != null ? data.flipCount : 0;
    $('metaLine').textContent =
      'Atlas · test=' +
      ((data.shock && data.shock.label) || '—') +
      ' · starting=' +
      data.sourceSymbol +
      ' · ' +
      src +
      ' · status changes=' +
      flips;
  }

  $('loadLast').addEventListener('click', () => {
    loadLastFreeze();
    runAtlas();
  });
  $('useSample').addEventListener('click', () => {
    mode = 'sample';
    deskFreeze = null;
    const _dq=$('dqBadge'); if (_dq) _dq.hidden = true;
    runAtlas();
  });
  $('runAtlas').addEventListener('click', () => runAtlas());
  ['sourceSymbol', 'shockType'].forEach((id) => {
    $(id).addEventListener('change', () => runAtlas());
  });

  loadLastFreeze();
  runAtlas().catch((e) => showFail(e));
})();
