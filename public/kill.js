/* Kill Board — what would prove the overnight rToken idea wrong. */
(function () {
  const $ = (id) => document.getElementById(id);
  const STORAGE = 'iw:killBoard';

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
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  let freeze = null;
  let band = null;
  let criteria = [];
  let from = 'none';

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function savePersisted() {
    localStorage.setItem(
      STORAGE,
      JSON.stringify({
        symbol: freeze?.symbol || $('symbol').value,
        criteria: criteria.map((c) => ({
          id: c.id,
          label: c.label,
          plain: c.plain,
          locked: Boolean(c.locked),
          check: c.check,
        })),
        at: new Date().toISOString(),
      })
    );
  }

  function loadLastFreeze() {
    try {
      const raw = localStorage.getItem('iw:lastFreeze');
      if (!raw) {
        $('metaLine').textContent = 'No last desk freeze. Use sample or run the Desk.';
        return false;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.freeze) return false;
      freeze = parsed.freeze;
      band = parsed.band || null;
      from = 'desk';
      if (parsed.symbol) $('symbol').value = parsed.symbol;
      $('metaLine').textContent =
        'Desk freeze · ' + (parsed.symbol || freeze.symbol) + ' · ' + (parsed.at || '');
      renderDqBadge(freeze);
      return true;
    } catch (err) {
      showFail(err);
      return false;
    }
  }

  async function loadSample() {
    const symbol = $('symbol').value;
    let r;
    try {
      r = await fetch('/api/sample-freeze?symbol=' + encodeURIComponent(symbol));
    } catch (err) {
      showFail(err);
      throw err;
    }
    const j = await r.json().catch(() => ({
      ok: false,
      error: r.statusText,
      failureKind: 'api',
    }));
    if (!j.ok) {
      showFail(null, j, r);
      throw new Error(j.error || 'sample failed');
    }
    freeze = j.freeze;
    band = j.band;
    from = 'sample';
    $('metaLine').textContent = 'Sample · ' + j.symbol;
    renderDqBadge(freeze);
  }

  function mergeEdits(apiCriteria) {
    const persisted = loadPersisted();
    const byId = {};
    if (persisted?.criteria) for (const c of persisted.criteria) byId[c.id] = c;
    for (const c of criteria) byId[c.id] = { ...byId[c.id], ...c };
    return apiCriteria.map((c) => {
      const edit = byId[c.id];
      if (!edit) return { ...c, locked: false };
      return {
        ...c,
        plain: edit.plain != null ? edit.plain : c.plain,
        label: edit.label != null ? edit.label : c.label,
        locked: Boolean(edit.locked),
      };
    });
  }

  async function refreshBoard() {
    try {
      if (!freeze) await loadSample();
      const body = {
        freeze,
        band,
        criteria: criteria.length
          ? criteria.map((c) => ({
              id: c.id,
              label: c.label,
              plain: c.plain,
              locked: c.locked,
              check: c.check,
            }))
          : undefined,
      };
      if (!criteria.length) delete body.criteria;

      let r;
      try {
        r = await fetch('/api/kill-board', {
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

      criteria = mergeEdits(j.criteria || []);
      const lightById = {};
      for (const c of j.criteria || []) lightById[c.id] = c;
      criteria = criteria.map((c) => ({
        ...c,
        light: lightById[c.id]?.light || c.light || 'AMBER',
        light_plain: lightById[c.id]?.light_plain || c.light_plain,
        check: c.check || lightById[c.id]?.check,
      }));

      renderList();
      savePersisted();
      renderDqBadge(freeze);
      const src = from === 'sample' ? 'sample' : 'desk freeze';
      $('metaLine').textContent =
        'Kill board · ' +
        (j.symbol || freeze.symbol) +
        ' · ' +
        src +
        (j.fromSample ? ' · sample' : '') +
        ' · ' +
        criteria.length +
        ' criteria';
    } catch (err) {
      showFail(err);
    }
  }

  function renderList() {
    const root = $('killList');
    root.innerHTML = criteria
      .map((c, i) => {
        const light = c.light || 'AMBER';
        const plainLabel =
          c.light_plain ||
          (light === 'GREEN' ? 'Clear' : light === 'AMBER' ? 'Watch' : 'Firing');
        return (
          '<article class="kill-row" data-idx="' +
          i +
          '">' +
          '<div class="kill-light ' +
          light +
          '" title="' +
          escAttr(plainLabel) +
          '">' +
          '<span class="dot" aria-hidden="true"></span>' +
          '<span>' +
          light +
          '</span>' +
          '<span style="font-weight:500;letter-spacing:0.04em">' +
          esc(plainLabel) +
          '</span>' +
          '</div>' +
          '<div class="kill-body">' +
          '<h3>' +
          esc(c.label) +
          '</h3>' +
          '<textarea data-field="plain" ' +
          (c.locked ? 'disabled' : '') +
          '>' +
          escAttr(c.plain) +
          '</textarea>' +
          '</div>' +
          '<div class="kill-actions">' +
          '<label class="lock">' +
          '<input type="checkbox" data-field="locked" ' +
          (c.locked ? 'checked' : '') +
          ' /> Lock' +
          '</label>' +
          '</div>' +
          '</article>'
        );
      })
      .join('');

    root.querySelectorAll('.kill-row').forEach((row) => {
      const idx = Number(row.getAttribute('data-idx'));
      const ta = row.querySelector('textarea[data-field="plain"]');
      const lock = row.querySelector('input[data-field="locked"]');
      ta.addEventListener('change', () => {
        criteria[idx].plain = ta.value;
        savePersisted();
      });
      ta.addEventListener('blur', () => {
        criteria[idx].plain = ta.value;
        savePersisted();
      });
      lock.addEventListener('change', () => {
        criteria[idx].locked = lock.checked;
        ta.disabled = lock.checked;
        savePersisted();
      });
    });
  }

  $('loadLast').addEventListener('click', () => {
    criteria = [];
    if (loadLastFreeze()) refreshBoard();
  });
  $('useSample').addEventListener('click', () => {
    criteria = [];
    loadSample().then(refreshBoard).catch(() => {});
  });
  $('refresh').addEventListener('click', () => refreshBoard());
  $('symbol').addEventListener('change', () => {
    if (from === 'sample') {
      criteria = [];
      loadSample().then(refreshBoard).catch(() => {});
    }
  });

  if (loadLastFreeze()) {
    refreshBoard().catch(() => loadSample().then(refreshBoard));
  } else {
    loadSample()
      .then(refreshBoard)
      .catch((e) => showFail(e));
  }
})();
