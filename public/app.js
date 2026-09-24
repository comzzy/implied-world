/* Implied World desk UI — client recompute mirrors src/stress.js (local only). */
(function () {
  const hash = window.location.hash || '';
  if (hash === '#docs' || hash.startsWith('#docs-')) {
    window.location.replace('/docs' + (hash === '#docs' ? '' : hash));
    return;
  }

  const K = 0.4;
  const STRESS_PAD_DEFAULT = 0.008;
  const EVENT_IMPORTANCE = { none: 0.1, geopolitics: 0.45, cpi_fomc: 0.7, earnings: 0.85 };

  const STATUS_PLAIN = {
    ROOM_LEFT: 'Room left',
    NO_ROOM: 'No room',
    OPEN_BUT_UNSTABLE: 'Unstable',
  };

  function statusPlain(code) {
    return STATUS_PLAIN[code] || code || '—';
  }

  function statusChipHtml(code) {
    const c = code || '—';
    const plain = statusPlain(code);
    return `STATUS ${c}<span class="plain-sub">${plain}</span>`;
  }

  function saveLastFreeze(data) {
    if (!data?.freeze) return false;
    const payload = JSON.stringify({
      freeze: data.freeze,
      band: data.band,
      symbol: data.symbol || data.freeze.symbol,
      at: new Date().toISOString(),
    });
    let ok = false;
    try {
      localStorage.setItem('iw:lastFreeze', payload);
      ok = true;
    } catch (_) { /* quota / private */ }
    try {
      sessionStorage.setItem('iw:lastFreeze', payload);
      ok = true;
    } catch (_) { /* ignore */ }
    return ok;
  }

  function readLastFreezeRaw() {
    try {
      return localStorage.getItem('iw:lastFreeze') || sessionStorage.getItem('iw:lastFreeze');
    } catch (_) {
      try {
        return sessionStorage.getItem('iw:lastFreeze');
      } catch (_) {
        return null;
      }
    }
  }

  let state = null; // last API payload

  const $ = (id) => document.getElementById(id);

  function showDeskFailure(err, data, res) {
    const kind = (data && data.failureKind) || classifyClientFailure(err, res);
    const msg =
      (data && (data.failureMessage || data.error)) ||
      (err && err.message) ||
      'Unknown failure';
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
                ? 'Writeup failed — numbers are still OK.'
                : 'Server failed.';
    const text =
      head +
      ' ' +
      String(msg)
        .replace(/^Server failed[^.]*\.\s*/i, '')
        .slice(0, 200);
    const empty = $('emptyState');
    if (empty) {
      empty.hidden = false;
      empty.innerHTML =
        '<span class="fail-banner' +
        (kind === 'writeup' ? ' writeup' : '') +
        '"><span class="fail-kind">' +
        esc(kind) +
        '</span>' +
        esc(text) +
        '</span>';
    }
    const desk = $('desk');
    if (desk && kind !== 'writeup') desk.hidden = true;
  }

  function classifyClientFailure(err, res) {
    const m = String((err && err.message) || '');
    if (/Failed to fetch|NetworkError|offline/i.test(m)) return 'network';
    if (res && (res.status === 504 || res.status === 408)) return 'timeout';
    if (res && res.status >= 400) return 'api';
    if (/timeout|timed out/i.test(m)) return 'timeout';
    return 'server';
  }


  function pct(x, d = 3) {
    if (x == null || !Number.isFinite(Number(x))) return 'n/a';
    return (Number(x) * 100).toFixed(d) + '%';
  }
  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }
  function tagSpan(tag) {
    const t = tag || 'assumed';
    return `<span class="tag ${t}">${t}</span>`;
  }

  function solveLocal(freeze, stressPad, overrides = {}) {
    const premium = Number(overrides.premium != null ? overrides.premium : freeze.premium?.value) || 0;
    const residualBtc = Number(overrides.residualBtc != null ? overrides.residualBtc : freeze.btc24hReturn?.value) || 0;
    const eventClass = freeze.eventClass?.value || 'none';
    const eventImportance = clamp(
      overrides.eventImportance != null
        ? Number(overrides.eventImportance)
        : freeze.eventImportance != null
          ? Number(freeze.eventImportance)
          : EVENT_IMPORTANCE[eventClass] ?? 0.1,
      0,
      1
    );
    const pad = stressPad != null ? Number(stressPad) : STRESS_PAD_DEFAULT;
    const mid = premium + K * eventImportance * residualBtc;
    const lo = mid - pad;
    const hi = mid + pad;
    const thin = Boolean(freeze.thinWrapper?.value);
    const realEvent = eventClass !== 'none' && eventImportance > 0.15;
    let status = 'ROOM_LEFT';
    if (premium >= hi) status = 'NO_ROOM';
    else if (premium < lo && realEvent && thin) status = 'OPEN_BUT_UNSTABLE';
    return { premium, residual_btc: residualBtc, event_importance: eventImportance, implied_gap_mid: mid, implied_gap_lo: lo, implied_gap_hi: hi, status, k: K, stress_pad: pad };
  }

  function presetStress(freeze, basePad, knobs) {
    const baseFreezePremium = Number(freeze.premium?.value) || 0;
    const shocks = [
      { id: 'event_to_zero', label: 'event → 0', ov: { eventImportance: 0 } },
      { id: 'wrapper_plus_1_5', label: 'wrapper +1.5%', ov: { premium: baseFreezePremium + (knobs.wrapperBump || 0) + 0.015 } },
      { id: 'btc_residual_minus_3', label: 'BTC residual −3%', ov: { residualBtc: (knobs.btcResidual != null ? knobs.btcResidual : Number(freeze.btc24hReturn?.value) || 0) - 0.03 } },
    ];
    return shocks.map((s) => {
      const ov = {
        eventImportance: knobs.eventImportance,
        premium: baseFreezePremium + (knobs.wrapperBump || 0),
        residualBtc: knobs.btcResidual,
        ...s.ov,
      };
      const band = solveLocal(freeze, basePad, ov);
      return { ...s, ...band, dies: band.status === 'NO_ROOM' || band.status === 'OPEN_BUT_UNSTABLE' };
    });
  }

  async function loadHealth() {
    try {
      const r = await fetch('/api/health');
      const j = await r.json();
      const us = j.mcp?.['bitget-us'];
      const sig = j.mcp?.['bitget-signal'];
      $('healthLine').textContent =
        `feeds · writer=${j.qwen_key_present ? 'ready' : 'off'} · cash=${us?.ok ? 'up' : 'down'} · residual=${sig?.ok ? 'up' : 'down'}`;
    } catch (err) {
      $('healthLine').textContent = 'feeds · unreachable (' + err.message + ')';
    }
  }

  let sessionTick = null;
  let sessionHoursAt = null;
  let sessionFrozenAt = null;
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hoursFromFreeze(freeze) {
    if (!freeze) return null;
    const h =
      freeze.hoursToCashOpen?.hours ??
      freeze.hoursToOpen?.hours ??
      null;
    const n = Number(h);
    return Number.isFinite(n) ? n : null;
  }

  function formatHoursLeft(h) {
    if (h == null || !Number.isFinite(h)) return null;
    const clamped = Math.max(0, h);
    const whole = Math.floor(clamped);
    const mins = Math.round((clamped - whole) * 60) % 60;
    return whole + 'h ' + mins + 'm';
  }

  function updateClockFromSession() {
    const clock = $('clock');
    if (!clock) return;
    if (sessionHoursAt == null) {
      clock.textContent = 'hours to cash open: —';
      return;
    }
    const elapsedH =
      sessionFrozenAt != null ? (Date.now() - sessionFrozenAt) / 3600000 : 0;
    const left = sessionHoursAt - elapsedH;
    const label = formatHoursLeft(left);
    clock.textContent =
      label != null ? 'hours to cash open: ' + label : 'hours to cash open: n/a';
  }

  function updateFreezeAge() {
    const el = $('freezeAge');
    if (!el) return;
    if (sessionFrozenAt == null) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - sessionFrozenAt) / 1000));
    el.hidden = false;
    el.classList.toggle('is-fresh', sec < 90);
    el.classList.toggle('is-aging', sec >= 90);
    if (sec < 60) el.textContent = 'freeze · ' + sec + 's ago';
    else if (sec < 3600) el.textContent = 'freeze · ' + Math.floor(sec / 60) + 'm ago';
    else el.textContent = 'freeze · ' + Math.floor(sec / 3600) + 'h ago';
  }

  function startSessionTick(freeze) {
    sessionHoursAt = hoursFromFreeze(freeze);
    sessionFrozenAt = Date.now();
    updateClockFromSession();
    updateFreezeAge();
    if (sessionTick) clearInterval(sessionTick);
    sessionTick = setInterval(() => {
      updateClockFromSession();
      updateFreezeAge();
    }, 1000);
  }

  function updateClock(freeze) {
    // Back-compat one-shot; prefer startSessionTick after a run.
    sessionHoursAt = hoursFromFreeze(freeze);
    if (sessionHoursAt == null) {
      $('clock').textContent = 'hours to cash open: n/a';
      return;
    }
    updateClockFromSession();
  }

  function setLamp(lamp) {
    const el = $('lamp');
    el.classList.remove('ALIGNED', 'CONTESTED', 'is-live');
    if (lamp) {
      el.classList.add(lamp);
      el.classList.add('is-live');
    }
    $('lampLabel').textContent = lamp || '—';
  }

  function markResultsArrive() {
    const desk = $('desk');
    if (!desk) return;
    desk.classList.remove('arrive-on');
    // reflow so animation can replay
    void desk.offsetWidth;
    if (!reduceMotion) desk.classList.add('arrive-on');
    const statusRow = document.querySelector('.status-row');
    if (statusRow) {
      statusRow.classList.add('is-live');
      statusRow.querySelectorAll('.chip').forEach((chip) => {
        chip.classList.remove('pulse-once');
        void chip.offsetWidth;
        if (!reduceMotion) chip.classList.add('pulse-once');
      });
    }
    const canvas = $('decayCanvas');
    if (canvas && !reduceMotion) {
      canvas.classList.remove('arrive-on');
      void canvas.offsetWidth;
      canvas.classList.add('arrive-on');
    }
  }

  function briefingHtml(br) {
    if (!br) {
      return '<span class="err">Research briefing unavailable — live numbers above still stand.</span>';
    }
    return [
      br.evidence &&
        '<div class="brief-block"><strong>Evidence</strong>\n' +
          esc(br.evidence) +
          '</div>',
      br.implied_world &&
        '<div class="brief-block"><strong>Implied world</strong>\n' +
          esc(br.implied_world) +
          '</div>',
      br.stress &&
        '<div class="brief-block"><strong>Stress</strong>\n' + esc(br.stress) + '</div>',
      br.considerations &&
        '<div class="brief-block"><strong>Considerations</strong>\n' +
          esc(br.considerations) +
          '</div>',
      br.invalidation &&
        '<div class="brief-block"><strong>Invalidation</strong>\n' +
          esc(br.invalidation) +
          '</div>',
    ]
      .filter(Boolean)
      .join('');
  }

  function setChip(el, text, cls) {
    el.textContent = text;
    el.className = 'chip ' + (cls || 'dim');
  }

  function renderKv(el, rows) {
    el.innerHTML = rows
      .map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`)
      .join('');
  }

  function renderFactor(data) {
    const f = data?.factor || {};
    const verdictEl = $('factorVerdict');
    const noteEl = $('factorNote');
    const peersEl = $('factorPeers');
    if (!verdictEl || !noteEl || !peersEl) return;

    const verdict = f.verdict || '—';
    verdictEl.textContent = verdict;
    verdictEl.className = 'factor-verdict' + (verdict && verdict !== '—' ? ' has-verdict' : '');

    const note = (f.note || '').trim();
    noteEl.textContent = note;
    noteEl.hidden = !note;

    const rows = Array.isArray(f.rows) ? f.rows : [];
    if (!rows.length) {
      peersEl.innerHTML = '<div class="factor-peers-empty">No peer premiums in this freeze.</div>';
      return;
    }
    peersEl.innerHTML =
      '<div class="factor-peers-head"><span>Symbol</span><span>Premium</span><span>Tag</span></div>' +
      rows
        .map((r) => {
          const sym = esc(r.symbol || '—') + (r.is_focus ? ' <em class="focus">focus</em>' : '');
          const prem = pct(r.premium, 2);
          const tag = tagSpan(r.tag);
          return `<div class="factor-peer-row${r.is_focus ? ' is-focus' : ''}"><span class="sym">${sym}</span><span class="prem">${prem}</span><span class="tg">${tag}</span></div>`;
        })
        .join('');
  }

  function renderStack(stackEl, legendEl, channels) {
    if (!channels) {
      stackEl.innerHTML = '';
      legendEl.innerHTML = '';
      return;
    }
    const n = channels.name_pct || 0;
    const b = channels.btc_residual_pct || 0;
    const w = channels.wrapper_pct || 0;
    stackEl.innerHTML =
      `<span class="name" data-w="${n}%" style="width:${n}%"></span>` +
      `<span class="btc" data-w="${b}%" style="width:${b}%"></span>` +
      `<span class="wrapper" data-w="${w}%" style="width:${w}%"></span>`;
    legendEl.innerHTML =
      `<span class="name"><i></i>name ${n}%</span>` +
      `<span class="btc"><i></i>btc_residual ${b}%</span>` +
      `<span class="wrapper"><i></i>wrapper ${w}%</span>`;
  }

  function drawDecay(outline, hoursNow) {
    const canvas = $('decayChart');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!outline || !outline.length) return;

    const pad = 28;
    const xs = outline.map((p) => p.hours);
    const ys = outline.flatMap((p) => [p.lo, p.hi, p.mid]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const xScale = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (W - pad * 2);
    const yScale = (y) => H - pad - ((y - minY) / (maxY - minY || 1)) * (H - pad * 2);

    ctx.strokeStyle = '#2a3340';
    ctx.beginPath();
    ctx.moveTo(pad, H - pad);
    ctx.lineTo(W - pad, H - pad);
    ctx.stroke();

    // Band fill
    ctx.fillStyle = 'rgba(200,164,92,0.12)';
    ctx.beginPath();
    outline.forEach((p, i) => {
      const x = xScale(p.hours);
      const y = yScale(p.hi);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = outline.length - 1; i >= 0; i--) {
      ctx.lineTo(xScale(outline[i].hours), yScale(outline[i].lo));
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#c8a45c';
    ctx.beginPath();
    outline.forEach((p, i) => {
      const x = xScale(p.hours);
      const y = yScale(p.mid);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (hoursNow != null) {
      ctx.strokeStyle = '#5b8fbf';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xScale(hoursNow), pad);
      ctx.lineTo(xScale(hoursNow), H - pad);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#5c6b7d';
    ctx.font = '10px IBM Plex Mono, monospace';
    ctx.fillText('hours →', W - pad - 40, H - 8);
    ctx.fillText('gap', 4, 14);
  }

  
  function plainTag(tag) {
    if (tag === 'observed' || tag === 'computed') return tag === 'computed' ? 'Computed' : 'Observed';
    if (tag === 'assumed' || tag === 'targeted') return 'Assumed';
    if (tag === 'source_failed') return 'Failed';
    return tag || 'Assumed';
  }

  function qualityRows(freeze) {
    if (!freeze) return [];
    const rows = [
      ['Cash close', freeze.cashClose?.tag, freeze.cashClose?.note],
      ['rToken / wrapper', freeze.rtoken?.tag, freeze.rtoken?.note],
      ['Premium', freeze.premium?.tag, freeze.premium?.formula],
      ['Hours to cash open', (freeze.hoursToCashOpen || freeze.hoursToOpen)?.tag, (freeze.hoursToCashOpen || freeze.hoursToOpen)?.note],
      ['BTC residual', freeze.btc24hReturn?.tag, freeze.btc24hReturn?.note],
      ['Nasdaq session', freeze.nasdaqLast?.tag, freeze.nasdaqLast?.note],
      ['Event class', freeze.eventClass?.tag, freeze.eventClass?.note],
      ['Thin wrapper', freeze.thinWrapper?.tag, freeze.thinWrapper?.note],
      ['Book spread', freeze.bookSpread?.tag, freeze.bookSpread?.note],
      ['Book depth', freeze.bookDepth?.tag, freeze.bookDepth?.note],
    ];
    return rows.filter((r) => r[1]);
  }

  function renderDataQuality(freeze) {
    const wrap = $('dataQuality');
    const list = $('dqList');
    if (!wrap || !list) return;
    const rows = qualityRows(freeze);
    if (!rows.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    list.innerHTML = rows
      .map(([label, tag, note]) => {
        const cls = tag === 'source_failed' ? 'source_failed' : tag || 'assumed';
        const title = note ? ` title="${esc(String(note).slice(0, 180))}"` : '';
        return `<span class="dq-item"${title}><span class="dq-label">${esc(label)}</span><span class="dq-pill ${cls}">${esc(plainTag(tag))}</span></span>`;
      })
      .join('');
  }


  function renderDesk(data) {
    state = data;
    const saved = saveLastFreeze(data);
    $('emptyState').hidden = true;
    renderDataQuality(data.freeze);
    $('desk').hidden = false;
    const hint = $('freezeSavedHint');
    if (hint) {
      const sym = data.symbol || data.freeze?.symbol || '—';
      hint.hidden = false;
      hint.textContent = saved
        ? 'Freeze saved · ' + sym
        : 'Freeze not saved in this browser.';
    }

    setLamp(data.lamp);
    startSessionTick(data.freeze);
    markResultsArrive();
    {
      const st = data.status || data.band?.status;
      const el = $('statusChip');
      el.className = 'chip ' + (st || 'dim');
      el.innerHTML = statusChipHtml(st);
    }
    setChip($('factorChip'), 'FACTOR ' + (data.factor?.verdict || '—'), 'dim');
    const survives = data.size?.band_survives;
    setChip(
      $('sizeChip'),
      survives == null ? 'SIZE —' : survives ? 'SIZE survives' : 'SIZE eats room',
      survives ? 'ROOM_LEFT' : 'NO_ROOM'
    );

    const f = data.freeze;
    const b = data.band;
    renderKv($('primaryKv'), [
      ['Wrapper gap', `${pct(b.premium)} ${tagSpan(f.premium?.tag)}`],
      ['Range low / middle / high', `${pct(b.implied_gap_lo)} · ${pct(b.implied_gap_mid)} · ${pct(b.implied_gap_hi)}`],
      ['Stress cushion (now)', pct(b.stress_pad, 2)],
      ['event', `${f.eventClass?.value} (ei=${(b.event_importance ?? 0).toFixed(2)}) ${tagSpan(f.eventClass?.tag)}`],
      ['BTC residual', `${pct(f.btc24hReturn?.value, 2)} ${tagSpan(f.btc24hReturn?.tag)}`],
      ['cash close', `${f.cashClose?.value ?? 'n/a'} ${tagSpan(f.cashClose?.tag)}`],
      ['rToken', `${f.rtoken?.value ?? 'n/a'} ${tagSpan(f.rtoken?.tag)}`],
    ]);
    renderStack($('primaryStack'), $('primaryLegend'), data.channels);

    const briefingEl = $('briefing');
    if (data.briefing) {
      briefingEl.innerHTML = briefingHtml(data.briefing);
    } else {
      // One compact muted line only — never stack a second fail-banner here.
      briefingEl.innerHTML =
        '<span class="err">Writing research note…</span>';
    }

    const tw = data.twin;
    renderKv($('twinKv'), [
      ['status', tw?.band?.status ? `${tw.band.status} · ${statusPlain(tw.band.status)}` : '—'],
      ['Range low / middle / high', `${pct(tw?.band?.implied_gap_lo)} · ${pct(tw?.band?.implied_gap_mid)} · ${pct(tw?.band?.implied_gap_hi)}`],
      ['residual (inverted)', pct(tw?.freeze_delta?.residual_btc, 2)],
      ['event importance', (tw?.freeze_delta?.event_importance ?? 0).toFixed(2)],
    ]);
    renderStack($('twinStack'), $('twinLegend'), tw?.channels);
    $('twinFraming').textContent = tw?.framing || '';

    drawDecay(data.decay?.outline, f.hoursToOpen?.hours);
    renderKv($('decayKv'), [
      ['band now pad', pct(data.decay?.band_now?.pad, 2)],
      ['band Friday-night pad', pct(data.decay?.band_if_friday_night?.pad, 2)],
      ['now status', data.decay?.band_now?.status ? `${data.decay.band_now.status} · ${statusPlain(data.decay.band_now.status)}` : '—'],
      ['Friday-night status', data.decay?.band_if_friday_night?.status ? `${data.decay.band_if_friday_night.status} · ${statusPlain(data.decay.band_if_friday_night.status)}` : '—'],
    ]);

    renderStress(data.stress);
    renderFactor(data);
    renderKv($('sizeKv'), [
      ['notional', (data.size?.notional_usdt ?? 0) + ' USDT'],
      ['size_eats_room_bps', String(data.size?.size_eats_room_bps ?? 'n/a')],
      ['band_width_bps', String(data.size?.band_width_bps ?? 'n/a')],
      ['survives', String(data.size?.band_survives)],
    ]);

    $('receiptBox').textContent = data.receipt?.copyable || '';
    $('copyReceipt').disabled = !data.receipt?.copyable;

    const ul = $('sourcesList');
    ul.innerHTML = (data.sources || [])
      .map(
        (s) =>
          `<li>${esc(s.name)} · ${s.ok ? 'ok' : 'fail'} · ${tagSpan(s.tag)}${s.error ? ' · ' + esc(String(s.error).slice(0, 80)) : ''}</li>`
      )
      .join('');

    // Init sliders from endpoints
    const ep = data.slider_endpoints || {};
    if (ep.eventImportance) {
      $('sEvent').value = ep.eventImportance.default;
      $('sEventVal').textContent = Number(ep.eventImportance.default).toFixed(2);
    }
    if (ep.wrapperBumpPct) {
      $('sWrap').value = ep.wrapperBumpPct.default;
      $('sWrapVal').textContent = Number(ep.wrapperBumpPct.default).toFixed(1) + '%';
    }
    if (ep.btcResidualPct) {
      $('sBtc').value = ep.btcResidualPct.default;
      $('sBtcVal').textContent = Number(ep.btcResidualPct.default).toFixed(1) + '%';
    }
    applySliders();

    $('footerAsOf').textContent = 'as of ' + (f.asOf || '');

    if (window.ImpliedMotion) {
      const desk = $('desk');
      window.ImpliedMotion.growBars(desk);
      window.ImpliedMotion.countUps(desk);
      window.ImpliedMotion.reveal(desk);
    }
  }

  function renderStress(stress) {
    const tb = $('stressTable').querySelector('tbody');
    tb.innerHTML = (stress?.rows || [])
      .map(
        (r) =>
          `<tr class="${r.dies ? 'die' : ''}"><td>${esc(r.label)}</td><td>${esc(r.status)} · ${esc(statusPlain(r.status))}</td>` +
          `<td class="num">${pct(r.mid)}</td><td class="num">${pct(r.lo)}</td><td class="num">${pct(r.hi)}</td></tr>`
      )
      .join('');
    const fd = stress?.firstToDie;
    renderKv($('firstDie'), [
      ['firstToDie', fd ? `${fd.label} → ${fd.status} (${statusPlain(fd.status)})` : 'none within presets'],
    ]);
  }

  function applySliders() {
    if (!state?.freeze) return;
    const eventImportance = Number($('sEvent').value);
    const wrapperBump = Number($('sWrap').value) / 100;
    const btcResidual = Number($('sBtc').value) / 100;
    $('sEventVal').textContent = eventImportance.toFixed(2);
    $('sWrapVal').textContent = (wrapperBump * 100).toFixed(1) + '%';
    $('sBtcVal').textContent = (btcResidual * 100).toFixed(1) + '%';

    const hours = state.freeze.hoursToOpen?.hours;
    const factor = hours != null ? clamp(hours / 48, 0.25, 1) : 1;
    const pad = STRESS_PAD_DEFAULT * factor;

    const band = solveLocal(state.freeze, pad, {
      eventImportance,
      premium: (Number(state.freeze.premium?.value) || 0) + wrapperBump,
      residualBtc: btcResidual,
    });
    const rows = presetStress(state.freeze, pad, { eventImportance, wrapperBump, btcResidual });
    const first = rows.find((r) => r.dies) || null;

    renderKv($('sliderKv'), [
      ['recomputed status', `${band.status} · ${statusPlain(band.status)}`],
      ['Range low / middle / high', `${pct(band.implied_gap_lo)} · ${pct(band.implied_gap_mid)} · ${pct(band.implied_gap_hi)}`],
      ['firstToDie (slider world)', first ? `${first.label} → ${first.status}` : 'none'],
    ]);

    // Update stress table live from slider world
    renderStress({
      rows: rows.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        mid: r.implied_gap_mid,
        lo: r.implied_gap_lo,
        hi: r.implied_gap_hi,
        dies: r.dies,
      })),
      firstToDie: first ? { id: first.id, label: first.label, status: first.status } : null,
    });
    if (window.ImpliedMotion) {
      window.ImpliedMotion.countUps($('sliderKv'));
      window.ImpliedMotion.countUps($('firstDie'));
    }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async function runDesk() {
    const btn = $('runBtn');
    const progress = $('runProgress');
    btn.disabled = true;
    btn.textContent = 'Running…';
    if (window.ImpliedMotion) window.ImpliedMotion.setLoading(true, $('desk-work'));
    const t0 = Date.now();
    let tick = null;
    let wake = null;
    const stages = [
      { at: 0, bar: 12, stage: 'Freezing cash last + wrapper' },
      { at: 4, bar: 28, stage: 'Pulling BTC residual + calendar weight' },
      { at: 9, bar: 48, stage: 'Solving implied band + stress' },
      { at: 14, bar: 68, stage: 'Twin / factor / size checks' },
      { at: 18, bar: 82, stage: 'Packaging desk numbers' },
    ];
    const msgEl = $('runProgressMsg');
    const stageEl = $('runProgressStage');
    const barEl = $('runProgressBar');
    const setProgress = (sec) => {
      if (!progress) return;
      progress.hidden = false;
      progress.classList.add('is-running');
      let cur = stages[0];
      for (const s of stages) {
        if (sec >= s.at) cur = s;
      }
      const bar = Math.min(92, cur.bar + Math.max(0, sec - cur.at));
      if (barEl) barEl.style.width = bar + '%';
      if (msgEl) {
        msgEl.textContent =
          'Still working… ' + sec + 's — keep this screen on';
      } else {
        progress.textContent =
          'Still working… ' + sec + 's — keep this screen on';
      }
      if (stageEl) stageEl.textContent = cur.stage;
    };
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        try {
          wake = await navigator.wakeLock.request('screen');
        } catch (_) {
          /* phone may deny — still show timer */
        }
      }
      tick = setInterval(() => {
        const sec = Math.round((Date.now() - t0) / 1000);
        setProgress(sec);
      }, 1000);
      setProgress(0);

      const body = {
        symbol: $('symbol').value,
        thesis: $('thesis').value,
        style: $('style').value,
        notionalUsdt: Number($('notional').value) || 5000,
        numbersOnly: true,
        skipBriefing: true,
      };

      async function postOnce() {
        const r = await fetch('/api/implied-world', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
        });
        const rawText = await r.text();
        let data;
        try {
          data = JSON.parse(rawText);
        } catch {
          const hint =
            r.status === 504 || r.status === 502
              ? 'Platform timeout — the desk ran too long. Try again.'
              : (rawText || 'Non-JSON response').slice(0, 180);
          const err = new Error(hint);
          err._failureKind = r.status === 504 || r.status === 502 ? 'timeout' : 'server';
          err._res = r;
          err._data = { failureKind: err._failureKind, ok: false };
          throw err;
        }
        if (!r.ok || data.ok === false) {
          const err = new Error(data.failureMessage || data.error || 'Desk failed');
          err._data = data;
          err._res = r;
          throw err;
        }
        return data;
      }

      let data;
      try {
        data = await postOnce();
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        const isNet = /Failed to fetch|NetworkError|offline|network/i.test(msg);
        if (isNet && !err._data) {
          setProgress('Connection dropped — retrying once…');
          data = await postOnce();
        } else if (err._data) {
          showDeskFailure(err._data.ok === false ? null : err, err._data, err._res);
          return;
        } else {
          throw err;
        }
      }
      renderDesk(data);
      fetchResearchBriefing(data);
    } catch (err) {
      showDeskFailure(err);
    } finally {
      if (tick) clearInterval(tick);
      if (progress) {
        progress.hidden = true;
        progress.classList.remove('is-running');
        if (msgEl) msgEl.textContent = '';
        if (stageEl) stageEl.textContent = '';
        if (barEl) barEl.style.width = '8%';
      }
      if (wake) {
        try {
          await wake.release();
        } catch (_) {}
      }
      btn.disabled = false;
      btn.textContent = 'Run desk';
      if (window.ImpliedMotion) window.ImpliedMotion.setLoading(false, $('desk-work'));
    }
  }


  async function fetchResearchBriefing(data) {
    const briefingEl = $('briefing');
    if (!briefingEl || !data || !data.freeze) return;
    briefingEl.innerHTML =
      '<span class="err">Writing research note…</span>';
    const body = {
      thesis: data.thesis || ($('thesis') && $('thesis').value) || '',
      style: data.style || ($('style') && $('style').value) || 'weekend_swing',
      freeze: data.freeze,
      band: data.band,
      size: data.size,
      factor: data.factor,
      receipt: data.receipt,
      twin: data.twin,
      channels: data.channels,
      stress: data.stress,
    };
    try {
      let r;
      try {
        r = await fetch('/api/briefing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
        });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/Failed to fetch|NetworkError|offline|network/i.test(msg)) {
          r = await fetch('/api/briefing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true,
          });
        } else {
          throw err;
        }
      }
      const j = await r.json().catch(() => ({
        ok: false,
        error: r.statusText,
        failureKind: 'writeup',
      }));
      if (!j.ok || !j.briefing) {
        briefingEl.innerHTML =
          '<span class="err">Research briefing unavailable — live numbers above still stand.</span>';
        return;
      }
      briefingEl.innerHTML = briefingHtml(j.briefing);
    } catch (err) {
      briefingEl.innerHTML =
        '<span class="err">Research briefing unavailable — live numbers above still stand.</span>';
    }
  }

  function wireDesk() {
    $('runBtn').addEventListener('click', runDesk);
    $('copyReceipt').addEventListener('click', async () => {
      const text = $('receiptBox').textContent;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        $('copyReceipt').textContent = 'Copied';
        setTimeout(() => { $('copyReceipt').textContent = 'Copy receipt'; }, 1200);
      } catch {
        $('copyReceipt').textContent = 'Copy failed';
      }
    });
    ['sEvent', 'sWrap', 'sBtc'].forEach((id) => {
      $(id).addEventListener('input', applySliders);
    });
    document.querySelectorAll('.nav a[data-nav]').forEach((a) => {
      a.addEventListener('click', () => {
        document.querySelectorAll('.nav a[data-nav]').forEach((x) => x.classList.remove('active'));
        a.classList.add('active');
      });
    });
    loadHealth();
  }

  function enterDesk() {
    const splash = document.getElementById('splash');
    const app = document.getElementById('app');
    if (!app) return;
    if (splash && splash.dataset.done === '1') return;
    if (splash) splash.dataset.done = '1';

    // Desk is already under the splash (Autiqo pattern): wire it, then slide splash away.
    app.hidden = false;
    app.removeAttribute('aria-hidden');
    wireDesk();

    if (splash) {
      splash.classList.add('is-leaving');
      setTimeout(() => {
        if (splash.parentNode) splash.remove();
        document.body.classList.remove('splash-active');
      }, 850);
    } else {
      document.body.classList.remove('splash-active');
    }

    requestAnimationFrame(() => {
      const target = document.getElementById('desk-work') || document.getElementById('desk-anchor');
      if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
      window.location.hash = 'desk-anchor';
      if (window.ImpliedMotion) window.ImpliedMotion.scan(document);
    });
  }

  function startSplash() {
    const splash = document.getElementById('splash');
    const app = document.getElementById('app');
    if (!splash) {
      if (app) {
        app.hidden = false;
        app.removeAttribute('aria-hidden');
      }
      document.body.classList.remove('splash-active');
      wireDesk();
      return;
    }
    // Mount desk under splash so the slide-up reveals a live dashboard
    if (app) {
      app.hidden = false;
      app.setAttribute('aria-hidden', 'true');
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hold = reduce ? 400 : 1200;
    const go = () => enterDesk();
    splash.addEventListener('click', go, { once: true });
    splash.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    splash.tabIndex = 0;
    setTimeout(go, hold);
  }

  startSplash();
})();
