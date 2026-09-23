/* Kill Board — what would prove the overnight rToken idea wrong. Live desk freeze only. */
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

  function emptyState(msg) {
    freeze = null;
    band = null;
    from = 'none';
    criteria = [];
    const list = $('killList');
    if (list) list.innerHTML = '';
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
      $('metaLine').textContent =
        'Kill board · ' +
        (j.symbol || freeze.symbol) +
        ' · desk freeze · ' +
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
          '<p class="kill-field-label">' +
          (c.locked ? 'Locked' : 'Criterion') +
          '</p>' +
          '<textarea data-field="plain" rows="4" placeholder="e.g. If wrapper premium sits at or above the band high, the overnight idea has no room left." ' +
          (c.locked ? 'disabled' : '') +
          '>' +
          esc(c.plain || '') +
          '</textarea>' +
          '</div>' +
          '<div class="kill-actions">' +
          '<label class="lock' +
          (c.locked ? ' is-locked' : '') +
          '">' +
          '<input type="checkbox" data-field="locked" ' +
          (c.locked ? 'checked' : '') +
          ' /> ' +
          (c.locked ? 'Locked' : 'Lock') +
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
        const label = row.querySelector('.lock');
        const fieldLabel = row.querySelector('.kill-field-label');
        if (label) {
          label.classList.toggle('is-locked', lock.checked);
          // refresh visible word next to checkbox
          const textNode = Array.from(label.childNodes).find(
            (n) => n.nodeType === 3 && n.textContent.trim()
          );
          if (textNode) textNode.textContent = lock.checked ? ' Locked' : ' Lock';
          else label.appendChild(document.createTextNode(lock.checked ? ' Locked' : ' Lock'));
        }
        if (fieldLabel) {
          fieldLabel.textContent = lock.checked ? 'Locked' : 'Criterion';
        }
        const meta = $('metaLine');
        if (meta) {
          const n = criteria.filter((x) => x.locked).length;
          meta.textContent =
            (freeze?.symbol || $('symbol').value) +
            ' · ' +
            n +
            '/' +
            criteria.length +
            ' locked';
        }
      });
    });
  }

  $('loadLast').addEventListener('click', () => {
    criteria = [];
    if (loadLastFreeze()) refreshBoard();
  });
  $('refresh').addEventListener('click', () => refreshBoard());
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
    criteria = [];
    refreshBoard();
  });

  if (loadLastFreeze()) {
    refreshBoard().catch((e) => showFail(e));
  }
})();
