/**
 * Implied World — site-wide motion (vanilla).
 * Adds html.js-motion so CSS can hide pre-reveal states only when JS runs.
 * Respects prefers-reduced-motion.
 */
(function () {
  'use strict';

  document.documentElement.classList.add('js-motion');

  function reduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  var io = null;
  var observed = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

  function ensureObserver() {
    if (io || typeof IntersectionObserver === 'undefined') return io;
    io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var delay = el.getAttribute('data-mw-delay');
          if (delay && !reduced()) {
            el.style.transitionDelay = delay;
          }
          el.classList.add('is-in');
          io.unobserve(el);
        });
      },
      { root: null, rootMargin: '0px 0px 64px 0px', threshold: 0.02 }
    );
    return io;
  }

  function reveal(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll('.mw-reveal:not(.is-in)');
    if (!nodes.length) return;
    if (reduced()) {
      nodes.forEach(function (el) {
        el.classList.add('is-in');
      });
      return;
    }
    var obs = ensureObserver();
    if (!obs) {
      nodes.forEach(function (el) {
        el.classList.add('is-in');
      });
      return;
    }
    nodes.forEach(function (el, i) {
      if (observed && observed.has(el)) return;
      if (observed) observed.add(el);
      if (!el.getAttribute('data-mw-delay') && i < 24) {
        el.setAttribute('data-mw-delay', Math.min(i * 0.04, 0.4).toFixed(2) + 's');
      }
      obs.observe(el);
    });
  }

  function parseLeadingNumber(text) {
    if (!text) return null;
    var m = String(text)
      .trim()
      .match(/^([+\−-]?)(\d+(?:\.\d+)?)(.*)$/);
    if (!m) return null;
    var sign = m[1] === '-' || m[1] === '−' ? -1 : 1;
    var value = sign * parseFloat(m[2]);
    if (!isFinite(value)) return null;
    return { value: value, raw: m[2], prefix: m[1] === '−' ? '−' : m[1], suffix: m[3] || '' };
  }

  function formatLike(raw, current) {
    var decimals = (raw.split('.')[1] || '').length;
    var fixed = decimals > 0 ? current.toFixed(decimals) : String(Math.round(current));
    return fixed;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animateNumSpan(span, finalText, duration) {
    if (reduced()) {
      span.textContent = finalText;
      return;
    }
    var parsed = parseLeadingNumber(finalText);
    if (!parsed) {
      span.textContent = finalText;
      return;
    }
    var from = 0;
    var prev = span.getAttribute('data-mw-prev');
    if (prev != null && prev !== '' && isFinite(Number(prev))) {
      from = Number(prev);
    }
    var start = performance.now();
    var dur = duration || 450;
    function frame(now) {
      var t = Math.min(1, (now - start) / dur);
      var v = from + (parsed.value - from) * easeOutCubic(t);
      var abs = Math.abs(v);
      var body = formatLike(parsed.raw, abs);
      var sign =
        parsed.value < 0 || (parsed.value === 0 && parsed.prefix === '-')
          ? parsed.prefix || '-'
          : parsed.prefix === '+'
            ? '+'
            : v < 0
              ? '-'
              : '';
      if (parsed.value >= 0 && parsed.prefix === '+') sign = '+';
      if (parsed.value < 0) sign = parsed.prefix || '-';
      if (t < 1) {
        span.textContent = sign + body + parsed.suffix;
        requestAnimationFrame(frame);
      } else {
        span.textContent = finalText;
        span.setAttribute('data-mw-prev', String(parsed.value));
      }
    }
    requestAnimationFrame(frame);
  }

  function flash(el) {
    if (!el || reduced()) return;
    el.classList.remove('mw-flash');
    void el.offsetWidth;
    el.classList.add('mw-flash');
    window.setTimeout(function () {
      el.classList.remove('mw-flash');
    }, 700);
  }

  function wrapAndCount(el) {
    if (!el || el.getAttribute('data-mw-done') === '1') return;
    var finalAttr = el.getAttribute('data-mw-final');
    var text = (finalAttr != null ? finalAttr : el.textContent || '').trim();
    if (!text || text === '—' || text === 'n/a' || text === 'N/A') {
      el.setAttribute('data-mw-done', '1');
      return;
    }
    var parsed = parseLeadingNumber(text);
    if (!parsed) {
      el.setAttribute('data-mw-done', '1');
      return;
    }

    var prevKey = el.getAttribute('data-mw-last');
    var changed = prevKey != null && prevKey !== text;
    el.setAttribute('data-mw-last', text);

    // Pure-text node: animate whole element
    if (!el.children.length) {
      if (changed) flash(el);
      if (reduced()) {
        el.textContent = text;
      } else {
        var span = document.createElement('span');
        span.className = 'mw-num';
        span.setAttribute('data-final', text);
        if (prevKey) {
          var prevParsed = parseLeadingNumber(prevKey);
          if (prevParsed) span.setAttribute('data-mw-prev', String(prevParsed.value));
        }
        el.textContent = '';
        el.appendChild(span);
        animateNumSpan(span, text, 480);
      }
      el.setAttribute('data-mw-done', '1');
      return;
    }

    // Mixed HTML (e.g. kv value + tag): animate first text node only
    var node = el.firstChild;
    if (node && node.nodeType === 3) {
      var nodeText = node.textContent.trim();
      var nodeParsed = parseLeadingNumber(nodeText);
      if (nodeParsed) {
        if (changed) flash(el);
        if (reduced()) {
          node.textContent = nodeText + (node.textContent.match(/\s*$/) || [''])[0];
        } else {
          var hold = nodeText;
          var span2 = document.createElement('span');
          span2.className = 'mw-num';
          span2.setAttribute('data-final', hold);
          if (prevKey) {
            var pp = parseLeadingNumber(prevKey);
            if (pp) span2.setAttribute('data-mw-prev', String(pp.value));
          }
          el.insertBefore(span2, node);
          el.removeChild(node);
          // preserve trailing space before siblings
          if (el.childNodes[1] && el.childNodes[1].nodeType !== 3) {
            el.insertBefore(document.createTextNode(' '), el.childNodes[1]);
          }
          animateNumSpan(span2, hold, 480);
        }
      }
    }
    el.setAttribute('data-mw-done', '1');
  }

  function countUps(root) {
    var scope = root && root.querySelectorAll ? root : document;
    // Reset done flags when rescanning a fresh render
    scope.querySelectorAll('[data-mw-done="1"]').forEach(function (el) {
      // only clear if text changed
      var last = el.getAttribute('data-mw-last');
      var now = (el.getAttribute('data-mw-final') || el.textContent || '').trim();
      // strip animated span text for compare
      if (el.querySelector && el.querySelector('.mw-num')) {
        var n = el.querySelector('.mw-num');
        now = (n.getAttribute('data-final') || n.textContent || '').trim();
        var rest = '';
        el.childNodes.forEach(function (c) {
          if (c === n) return;
          rest += c.textContent || '';
        });
        now = now + rest.trimEnd();
        now = (n.getAttribute('data-final') || '').trim();
        // compare against stored full last
      }
      if (last != null) {
        var currentFinal = el.getAttribute('data-mw-final');
        if (currentFinal == null) {
          // rebuild from children
          if (el.querySelector('.mw-num')) {
            currentFinal = el.querySelector('.mw-num').getAttribute('data-final');
          } else {
            currentFinal = el.textContent.trim();
          }
        }
        // Always allow re-count on new render: clear done if parent was re-innerHTML'd
      }
    });

    var sels = [
      '.kv .v',
      '.factor-peer-row .prem',
      '.atlas-cell .mid',
      '[data-mw-count]',
    ];
    sels.forEach(function (sel) {
      scope.querySelectorAll(sel).forEach(function (el) {
        // Fresh nodes from innerHTML won't have data-mw-done
        wrapAndCount(el);
      });
    });
  }

  function growBars(root) {
    var scope = root && root.querySelectorAll ? root : document;
    if (reduced()) {
      scope.querySelectorAll('.stack span[data-w]').forEach(function (s) {
        s.style.width = s.getAttribute('data-w');
      });
      return;
    }
    scope.querySelectorAll('.stack').forEach(function (stack) {
      stack.classList.add('mw-grow');
      stack.querySelectorAll('span').forEach(function (s) {
        var w = s.getAttribute('data-w') || s.style.width;
        if (!w) return;
        s.setAttribute('data-w', w);
        s.style.width = '0%';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            s.style.width = w;
          });
        });
      });
    });
  }

  function pulse(els) {
    if (reduced()) return;
    var list = typeof els.length === 'number' ? els : [els];
    Array.prototype.forEach.call(list, function (el) {
      if (!el) return;
      el.classList.remove('mw-pulse');
      void el.offsetWidth;
      el.classList.add('mw-pulse');
      window.setTimeout(function () {
        el.classList.remove('mw-pulse');
      }, 650);
    });
  }

  function setLoading(on, target) {
    var el = target || document.getElementById('desk-work') || document.querySelector('.page-hero');
    if (!el) return;
    el.classList.toggle('is-loading', !!on);
  }

  function staggerFill(container, itemSelector, stepMs) {
    if (!container) return;
    var items = container.querySelectorAll(itemSelector || ':scope > *');
    if (reduced()) {
      items.forEach(function (el) {
        el.classList.add('mw-filled');
      });
      return;
    }
    var step = stepMs != null ? stepMs : 35;
    items.forEach(function (el, i) {
      el.classList.remove('mw-filled');
      el.style.setProperty('--mw-i', String(i));
      el.style.animationDelay = i * (step / 1000) + 's';
      requestAnimationFrame(function () {
        el.classList.add('mw-filled');
      });
    });
  }

  function heatIn(cells) {
    if (!cells) return;
    var list = typeof cells.length === 'number' ? cells : [cells];
    Array.prototype.forEach.call(list, function (el, i) {
      el.classList.add('heat-neutral');
      if (reduced()) {
        el.classList.remove('heat-neutral');
        el.classList.add('heat-on');
        return;
      }
      window.setTimeout(function () {
        el.classList.remove('heat-neutral');
        el.classList.add('heat-on');
      }, 40 + i * 90);
    });
  }

  function wireFaq() {
    document.querySelectorAll('.docs-faq details').forEach(function (d) {
      if (d.getAttribute('data-mw-faq') === '1') return;
      d.setAttribute('data-mw-faq', '1');
      d.addEventListener('toggle', function () {
        if (reduced()) return;
        if (d.open) {
          d.classList.add('mw-faq-open');
        } else {
          d.classList.remove('mw-faq-open');
        }
      });
      if (d.open) d.classList.add('mw-faq-open');
    });
  }

  function scan(root) {
    reveal(root || document);
    countUps(root || document);
    growBars(root || document);
    wireFaq();
  }

  function forceVisibleInView() {
    document.querySelectorAll('.mw-reveal:not(.is-in)').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight + 80 && r.bottom > -40) {
        el.classList.add('is-in');
      }
    });
  }

  function boot() {
    // mark common static blocks
    var auto = [
      '.section-head',
      '.desk-intro',
      '.explore-card',
      '.topbar',
      '.controls',
      '.page-hero > .kicker',
      '.page-hero > h1',
      '.feature-controls',
      '.docs-block',
      '.footer-inner',
      '.lattice-meta',
      '.feature-footer-note',
      '.dq-badge',
    ];
    auto.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (!el.classList.contains('mw-reveal')) el.classList.add('mw-reveal');
      });
    });
    scan(document);
    forceVisibleInView();
    window.setTimeout(forceVisibleInView, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-scan when splash leaves / late content
  window.addEventListener('load', function () {
    scan(document);
  });

  window.ImpliedMotion = {
    reduced: reduced,
    reveal: reveal,
    countUps: countUps,
    growBars: growBars,
    pulse: pulse,
    setLoading: setLoading,
    staggerFill: staggerFill,
    heatIn: heatIn,
    scan: scan,
    flash: flash,
  };
})();
